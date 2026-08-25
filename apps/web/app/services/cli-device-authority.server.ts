import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'

export type DeviceAuthorizationIntent = {
  preset: 'unrestricted' | 'agent'
  deviceName: string | null
  projectSelector: string | null
}

export type StoredDeviceAuthorizationIntent = DeviceAuthorizationIntent & {
  selectedProjectId: string | null
}

export type FixedAgentApprovalProject = {
  id: string
  name: string
  baseVisibility: 'workspace' | 'private'
  updatedAt: string
}

const PROJECT_SELECTOR_MAX_CODE_POINTS = 120

function normalizeProjectSelector(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const size = Array.from(trimmed).length
  return size >= 1 && size <= PROJECT_SELECTOR_MAX_CODE_POINTS ? trimmed : null
}

export function readDeviceAuthorizationIntent(
  payload: unknown,
): DeviceAuthorizationIntent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  if (record.preset !== 'unrestricted' && record.preset !== 'agent') return null
  const hasProjectSelector = Object.hasOwn(record, 'project_selector')
  const projectSelector = hasProjectSelector
    ? normalizeProjectSelector(record.project_selector)
    : null
  if (hasProjectSelector && !projectSelector) return null
  if (record.preset !== 'agent' && projectSelector) return null
  const deviceName =
    typeof record.device_name === 'string'
      ? record.device_name.trim().slice(0, 100) || null
      : null
  return { preset: record.preset, deviceName, projectSelector }
}

export async function storeDeviceAuthorizationIntent(
  deviceCode: string,
  intent: DeviceAuthorizationIntent,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE deviceCode
        SET preset = ?, deviceName = ?, approvalNonce = ?,
            requestedProjectSelector = ?
      WHERE deviceCode = ? AND status = 'pending'`,
  )
    .bind(
      intent.preset,
      intent.deviceName,
      nanoid(),
      intent.projectSelector,
      deviceCode,
    )
    .run()
}

export async function loadDeviceAuthorizationIntent(
  deviceCode: string,
): Promise<StoredDeviceAuthorizationIntent | null> {
  const row = await env.DB.prepare(
    `SELECT preset, deviceName, selectedProjectId, requestedProjectSelector
       FROM deviceCode
      WHERE deviceCode = ?`,
  )
    .bind(deviceCode)
    .first<{
      preset: 'unrestricted' | 'agent' | null
      deviceName: string | null
      selectedProjectId: string | null
      requestedProjectSelector: string | null
    }>()
  if (!row?.preset) return null
  return {
    preset: row.preset,
    deviceName: row.deviceName,
    projectSelector: row.requestedProjectSelector,
    selectedProjectId: row.selectedProjectId,
  }
}

export async function attachAgentBootstrapAuthority(
  sessionToken: string,
  intent: StoredDeviceAuthorizationIntent,
): Promise<boolean> {
  if (intent.preset !== 'agent' || !intent.selectedProjectId) return false
  const row = await env.DB.prepare(
    `SELECT sessions.id AS session_id, sessions.user_id, sessions.expires_at,
            users.workspace_id, artifact_containers.name AS project_name
       FROM sessions
       -- Device-flow approval is a human-only path; bots receive their agent
       -- families directly from the workspace-admin creation batch.
       JOIN users ON users.id = sessions.user_id AND users.kind = 'human'
       JOIN artifact_containers
         ON artifact_containers.id = ?
        AND artifact_containers.workspace_id = users.workspace_id
        AND artifact_containers.kind = 'project'
        AND artifact_containers.archived_at IS NULL
      WHERE sessions.token = ?`,
  )
    .bind(intent.selectedProjectId, sessionToken)
    .first<{
      session_id: string
      user_id: string
      expires_at: string
      workspace_id: string
      project_name: string
    }>()
  if (!row) return false
  const now = nowIso()
  const profileId = nanoid()
  const bootstrapExpiry = new Date(
    Math.min(new Date(row.expires_at).getTime(), Date.now() + 10 * 60 * 1000),
  ).toISOString()
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO agent_profiles (id, user_id, workspace_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(profileId, row.user_id, row.workspace_id, now),
    env.DB.prepare(
      `INSERT INTO cli_session_authorities (
         session_id, family_id, kind, preset, workspace_id, project_id,
         agent_profile_id, expires_at, bearer_only, created_at
       )
       SELECT ?, NULL, 'bootstrap', 'agent', ?, ?, agent_profiles.id, ?, 1, ?
         FROM agent_profiles
        WHERE user_id = ? AND workspace_id = ?`,
    ).bind(
      row.session_id,
      row.workspace_id,
      intent.selectedProjectId,
      bootstrapExpiry,
      now,
      row.user_id,
      row.workspace_id,
    ),
  ])
  return results.every((result) => result.success)
}

export async function revokeSessionToken(sessionToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?')
    .bind(sessionToken)
    .run()
}

export async function loadAgentApprovalContext(
  userCode: string,
  userId: string,
  workspaceId: string,
  email: string,
): Promise<{
  preset: 'agent'
  deviceName: string | null
  projectSelector: string | null
  fixedProject: FixedAgentApprovalProject | null
  fixedProjectError: boolean
} | null> {
  const intent = await env.DB.prepare(
    `SELECT preset, deviceName, requestedProjectSelector
       FROM deviceCode
      WHERE userCode = ? AND userId = ? AND status = 'pending' AND expiresAt > ?`,
  )
    .bind(userCode, userId, nowIso())
    .first<{
      preset: string | null
      deviceName: string | null
      requestedProjectSelector: string | null
    }>()
  if (intent?.preset !== 'agent') return null
  const fixedProject = intent.requestedProjectSelector
    ? await resolveFixedAgentApprovalProject({
        selector: intent.requestedProjectSelector,
        workspaceId,
        email,
      })
    : null
  return {
    preset: 'agent',
    deviceName: intent.deviceName,
    projectSelector: intent.requestedProjectSelector,
    fixedProject,
    fixedProjectError: Boolean(
      intent.requestedProjectSelector && !fixedProject,
    ),
  }
}

async function resolveFixedAgentApprovalProject(input: {
  selector: string
  workspaceId: string
  email: string
}): Promise<FixedAgentApprovalProject | null> {
  const byId = await env.DB.prepare(
    `SELECT id, name, workspace_id, kind, archived_at, base_visibility, updated_at,
            CASE WHEN base_visibility = 'workspace' OR EXISTS (
              SELECT 1 FROM project_share_defaults
               WHERE project_container_id = artifact_containers.id
                 AND lower(email) = lower(?)
                 AND role IN ('contributor', 'manager')
            ) THEN 1 ELSE 0 END AS eligible
       FROM artifact_containers
      WHERE id = ?`,
  )
    .bind(input.email, input.selector)
    .first<{
      id: string
      name: string
      workspace_id: string
      kind: string
      archived_at: string | null
      base_visibility: 'workspace' | 'private'
      updated_at: string
      eligible: number
    }>()
  if (byId) {
    return byId.workspace_id === input.workspaceId &&
      byId.kind === 'project' &&
      byId.archived_at === null &&
      byId.eligible === 1
      ? fixedProjectFromRow(byId)
      : null
  }

  const byName = await env.DB.prepare(
    `SELECT id, name, base_visibility, updated_at
       FROM artifact_containers
      WHERE workspace_id = ? AND kind = 'project' AND archived_at IS NULL
        AND name = ? COLLATE NOCASE
        AND (
          base_visibility = 'workspace'
          OR EXISTS (
            SELECT 1 FROM project_share_defaults
             WHERE project_container_id = artifact_containers.id
               AND lower(email) = lower(?)
               AND role IN ('contributor', 'manager')
          )
        )
      LIMIT 2`,
  )
    .bind(input.workspaceId, input.selector, input.email)
    .all<{
      id: string
      name: string
      base_visibility: 'workspace' | 'private'
      updated_at: string
    }>()
  return byName.results.length === 1
    ? fixedProjectFromRow(byName.results[0])
    : null
}

function fixedProjectFromRow(row: {
  id: string
  name: string
  base_visibility: 'workspace' | 'private'
  updated_at: string
}): FixedAgentApprovalProject {
  return {
    id: row.id,
    name: row.name,
    baseVisibility: row.base_visibility,
    updatedAt: row.updated_at,
  }
}

export async function isAgentDeviceApproval(
  userCode: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM deviceCode
      WHERE userCode = ? AND preset = 'agent' AND status = 'pending'
        AND expiresAt > ?`,
  )
    .bind(userCode, nowIso())
    .first<{ found: number }>()
  return row?.found === 1
}

export async function selectAgentApprovalProject(input: {
  userCode: string
  userId: string
  workspaceId: string
  email: string
  projectId: string
}): Promise<boolean> {
  const approval = await loadAgentApprovalContext(
    input.userCode,
    input.userId,
    input.workspaceId,
    input.email,
  )
  if (!approval) return false
  if (
    approval.projectSelector &&
    (approval.fixedProjectError ||
      approval.fixedProject?.id !== input.projectId)
  ) {
    return false
  }
  const result = await env.DB.prepare(
    `UPDATE deviceCode
        SET selectedProjectId = ?
      WHERE userCode = ? AND userId = ? AND preset = 'agent'
        AND status = 'pending' AND expiresAt > ?
        AND EXISTS (
          SELECT 1 FROM artifact_containers
           WHERE artifact_containers.id = ?
             AND artifact_containers.workspace_id = ?
             AND artifact_containers.kind = 'project'
             AND archived_at IS NULL
             AND (
               artifact_containers.base_visibility = 'workspace'
               OR EXISTS (
                 SELECT 1 FROM project_share_defaults
                  WHERE project_container_id = artifact_containers.id
                    AND lower(email) = lower(?)
                    AND role IN ('contributor', 'manager')
               )
             )
        )`,
  )
    .bind(
      input.projectId,
      input.userCode,
      input.userId,
      nowIso(),
      input.projectId,
      input.workspaceId,
      input.email,
    )
    .run()
  return result.meta.changes === 1
}

export async function clearAgentApprovalProject(input: {
  userCode: string
  userId: string
}): Promise<void> {
  await env.DB.prepare(
    `UPDATE deviceCode SET selectedProjectId = NULL
      WHERE userCode = ? AND userId = ? AND preset = 'agent'
        AND status = 'pending'`,
  )
    .bind(input.userCode, input.userId)
    .run()
}
