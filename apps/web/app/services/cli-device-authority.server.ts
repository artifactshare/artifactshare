import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'

export type DeviceAuthorizationIntent = {
  preset: 'unrestricted' | 'agent'
  deviceName: string | null
}

export type StoredDeviceAuthorizationIntent = DeviceAuthorizationIntent & {
  selectedProjectId: string | null
}

export function readDeviceAuthorizationIntent(
  payload: unknown,
): DeviceAuthorizationIntent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  if (record.preset !== 'unrestricted' && record.preset !== 'agent') return null
  const deviceName =
    typeof record.device_name === 'string'
      ? record.device_name.trim().slice(0, 100) || null
      : null
  return { preset: record.preset, deviceName }
}

export async function storeDeviceAuthorizationIntent(
  deviceCode: string,
  intent: DeviceAuthorizationIntent,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE deviceCode
        SET preset = ?, deviceName = ?, approvalNonce = ?
      WHERE deviceCode = ? AND status = 'pending'`,
  )
    .bind(intent.preset, intent.deviceName, nanoid(), deviceCode)
    .run()
}

export async function loadDeviceAuthorizationIntent(
  deviceCode: string,
): Promise<StoredDeviceAuthorizationIntent | null> {
  const row = await env.DB.prepare(
    `SELECT preset, deviceName, selectedProjectId
       FROM deviceCode
      WHERE deviceCode = ?`,
  )
    .bind(deviceCode)
    .first<{
      preset: 'unrestricted' | 'agent' | null
      deviceName: string | null
      selectedProjectId: string | null
    }>()
  if (!row?.preset) return null
  return {
    preset: row.preset,
    deviceName: row.deviceName,
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
       JOIN users ON users.id = sessions.user_id
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
  workspaceId: string,
  email: string,
): Promise<{
  preset: 'agent'
  deviceName: string | null
  projects: Array<{ id: string; name: string }>
} | null> {
  const intent = await env.DB.prepare(
    `SELECT preset, deviceName
       FROM deviceCode
      WHERE userCode = ? AND status = 'pending' AND expiresAt > ?`,
  )
    .bind(userCode, nowIso())
    .first<{ preset: string | null; deviceName: string | null }>()
  if (intent?.preset !== 'agent') return null
  const projects = await env.DB.prepare(
    `SELECT id, name FROM artifact_containers
      WHERE workspace_id = ? AND kind = 'project' AND archived_at IS NULL
        AND (
          base_visibility = 'workspace'
          OR EXISTS (
            SELECT 1 FROM project_share_defaults
             WHERE project_container_id = artifact_containers.id
               AND lower(email) = lower(?)
               AND role IN ('contributor', 'manager')
          )
        )
      ORDER BY name COLLATE NOCASE, id`,
  )
    .bind(workspaceId, email)
    .all<{ id: string; name: string }>()
  return {
    preset: 'agent',
    deviceName: intent.deviceName,
    projects: projects.results,
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
