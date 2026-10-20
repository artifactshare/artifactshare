import { sql } from 'kysely'
import { withDb } from './db.server'
import { runD1BatchWithResults } from '~/lib/d1-batch.server'
import { projectPlacementSql } from './projects.server'
import {
  PublisherClientNameSchema,
  PublisherApprovalChoiceSchema,
} from '@artifactshare/contract'
import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'

export type DeviceAuthorizationIntent = {
  preset: 'unrestricted' | 'agent' | 'publisher'
  deviceName: string | null
  projectSelector: string | null
}

export type StoredDeviceAuthorizationIntent = DeviceAuthorizationIntent & {
  selectedProjectId: string | null
  selectedPublisherClientId?: string | null
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
  if (
    record.preset !== 'unrestricted' &&
    record.preset !== 'agent' &&
    record.preset !== 'publisher'
  )
    return null
  const hasProjectSelector = Object.hasOwn(record, 'project_selector')
  const projectSelector = hasProjectSelector
    ? normalizeProjectSelector(record.project_selector)
    : null
  if (hasProjectSelector && !projectSelector) return null
  if (record.preset !== 'agent' && projectSelector) return null
  const publisherName = PublisherClientNameSchema.safeParse(record.device_name)
  if (record.preset === 'publisher' && !publisherName.success) return null
  const deviceName =
    record.preset === 'publisher' && publisherName.success
      ? publisherName.data
      : typeof record.device_name === 'string'
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
    `SELECT preset, deviceName, selectedProjectId, selectedPublisherClientId, requestedProjectSelector
       FROM deviceCode
      WHERE deviceCode = ?`,
  )
    .bind(deviceCode)
    .first<{
      preset: 'unrestricted' | 'agent' | 'publisher' | null
      deviceName: string | null
      selectedPublisherClientId: string | null
      selectedProjectId: string | null
      requestedProjectSelector: string | null
    }>()
  if (!row || row.preset === null) return null
  return {
    preset: row.preset,
    deviceName: row.deviceName,
    projectSelector: row.requestedProjectSelector,
    selectedProjectId: row.selectedProjectId,
    ...(row.preset === 'publisher'
      ? { selectedPublisherClientId: row.selectedPublisherClientId }
      : {}),
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
  return withDb(async (db) => {
    const permission = projectPlacementSql(
      { id: row.user_id, workspaceId: row.workspace_id },
      intent.selectedProjectId!,
      true,
    )
    const results = await runD1BatchWithResults(
      db,
      {
        compile: () =>
          sql`INSERT OR IGNORE INTO agent_profiles (id, user_id, workspace_id, created_at)
        SELECT ${profileId}, ${row.user_id}, ${row.workspace_id}, ${now} WHERE ${permission}`.compile(
            db,
          ),
      },
      {
        compile: () =>
          sql`INSERT INTO cli_session_authorities (
        session_id, family_id, kind, preset, workspace_id, project_id,
        agent_profile_id, expires_at, bearer_only, created_at)
        SELECT ${row.session_id}, NULL, 'bootstrap', 'agent', ${row.workspace_id}, ${intent.selectedProjectId}, agent_profiles.id, ${bootstrapExpiry}, 1, ${now}
        FROM agent_profiles WHERE user_id = ${row.user_id} AND workspace_id = ${row.workspace_id} AND ${permission}`.compile(
            db,
          ),
      },
    )
    return (
      results.every((result) => (result as D1Result).success) &&
      (results[1] as D1Result).meta.changes === 1
    )
  })
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
        userId,
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

function resolveFixedAgentApprovalProject(input: {
  userId: string
  selector: string
  workspaceId: string
  email: string
}): Promise<FixedAgentApprovalProject | null> {
  return withDb(async (db) => {
    const permission = projectPlacementSql(
      { id: input.userId, workspaceId: input.workspaceId },
      sql.ref('artifact_containers.id'),
      true,
    )
    const byId = await db
      .selectFrom('artifact_containers')
      .select([
        'id',
        'name',
        'workspace_id',
        'kind',
        'archived_at',
        'base_visibility',
        'updated_at',
      ])
      .select(
        sql<number>`CASE WHEN ${permission} THEN 1 ELSE 0 END`.as('eligible'),
      )
      .where('id', '=', input.selector)
      .executeTakeFirst()
    if (byId)
      return byId.workspace_id === input.workspaceId &&
        byId.kind === 'project' &&
        byId.archived_at === null &&
        byId.eligible === 1
        ? fixedProjectFromRow(byId)
        : null
    const byName = await db
      .selectFrom('artifact_containers')
      .select(['id', 'name', 'base_visibility', 'updated_at'])
      .where('workspace_id', '=', input.workspaceId)
      .where(sql<boolean>`name = ${input.selector} COLLATE NOCASE`)
      .where(permission)
      .limit(2)
      .execute()
    return byName.length === 1 ? fixedProjectFromRow(byName[0]) : null
  })
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
  return withDb(async (db) => {
    const result = await db
      .updateTable('deviceCode')
      .set({ selectedProjectId: input.projectId })
      .where('userCode', '=', input.userCode)
      .where('userId', '=', input.userId)
      .where('preset', '=', 'agent')
      .where('status', '=', 'pending')
      .where('expiresAt', '>', nowIso())
      .where(
        projectPlacementSql(
          { id: input.userId, workspaceId: input.workspaceId },
          input.projectId,
          true,
        ),
      )
      .executeTakeFirst()
    return result.numUpdatedRows === 1n
  })
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

export async function isPublisherDeviceApproval(
  userCode: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT preset FROM deviceCode WHERE userCode = ?',
  )
    .bind(userCode)
    .first<{ preset: string }>()
  return row?.preset === 'publisher'
}

export async function loadPublisherApprovalContext(
  userCode: string,
  userId: string,
  workspaceId: string,
) {
  const intent = await env.DB.prepare(`SELECT deviceName FROM deviceCode
    WHERE userCode = ? AND userId = ? AND preset = 'publisher' AND status = 'pending' AND expiresAt > ?
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND kind = 'human')
    AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = deviceCode.userId AND m.status = 'removed' AND m.workspace_id = (SELECT workspace_id FROM users WHERE id = deviceCode.userId))`)
    .bind(userCode, userId, nowIso(), userId, workspaceId)
    .first<{ deviceName: string }>()
  if (!intent) return null
  const clients = await env.DB.prepare(
    'SELECT id, name FROM publisher_clients WHERE user_id = ? AND workspace_id = ? ORDER BY name',
  )
    .bind(userId, workspaceId)
    .all<{ id: string; name: string }>()
  return {
    preset: 'publisher' as const,
    requestedName: intent.deviceName,
    clients: clients.results,
  }
}

export async function selectPublisherApprovalClient(input: {
  userCode: string
  userId: string
  workspaceId: string
  choice: unknown
}): Promise<boolean> {
  const choice = PublisherApprovalChoiceSchema.safeParse(input.choice)
  if (!choice.success) return false
  const context = await loadPublisherApprovalContext(
    input.userCode,
    input.userId,
    input.workspaceId,
  )
  if (!context) return false
  const clientId =
    choice.data.mode === 'create-new' ? nanoid() : choice.data.client_id
  const statements = []
  if (choice.data.mode === 'create-new') {
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO publisher_clients (id, user_id, workspace_id, name, created_at)
      SELECT ?, ?, ?, deviceName, ? FROM deviceCode
      WHERE userCode = ? AND userId = ? AND status = 'pending' AND preset = 'publisher'
        AND selectedPublisherClientId IS NULL AND expiresAt > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND kind = 'human')`).bind(
        clientId,
        input.userId,
        input.workspaceId,
        nowIso(),
        input.userCode,
        input.userId,
        nowIso(),
        input.userId,
        input.workspaceId,
      ),
    )
  }
  statements.push(
    env.DB.prepare(`UPDATE deviceCode SET selectedPublisherClientId = ?
    WHERE userCode = ? AND userId = ? AND status = 'pending' AND preset = 'publisher'
      AND selectedPublisherClientId IS NULL AND expiresAt > ?
      AND EXISTS (SELECT 1 FROM publisher_clients pc JOIN users u ON u.id = pc.user_id
        WHERE pc.id = ? AND pc.user_id = ? AND pc.workspace_id = ? AND u.workspace_id = pc.workspace_id AND u.kind = 'human'
          AND NOT EXISTS (SELECT 1 FROM workspace_members pm WHERE pm.user_id = u.id AND pm.workspace_id = pc.workspace_id AND pm.status = 'removed'))`).bind(
      clientId,
      input.userCode,
      input.userId,
      nowIso(),
      clientId,
      input.userId,
      input.workspaceId,
    ),
  )
  const results = await env.DB.batch(statements)
  return results.at(-1)?.meta.changes === 1
}

export async function clearPublisherApprovalClient(
  userCode: string,
  userId: string,
) {
  await env.DB.prepare(`UPDATE deviceCode SET selectedPublisherClientId = NULL
    WHERE userCode = ? AND userId = ? AND preset = 'publisher' AND status = 'pending'`)
    .bind(userCode, userId)
    .run()
}

export async function attachPublisherBootstrapAuthority(
  sessionToken: string,
  intent: StoredDeviceAuthorizationIntent,
): Promise<boolean> {
  if (intent.preset !== 'publisher' || !intent.selectedPublisherClientId)
    return false
  const now = nowIso()
  const result = await env.DB.prepare(`INSERT INTO cli_session_authorities
    (session_id, family_id, kind, preset, workspace_id, project_id, agent_profile_id, publisher_client_id, expires_at, bearer_only, created_at)
    SELECT s.id, NULL, 'bootstrap', 'publisher', pc.workspace_id, NULL, NULL, pc.id, min(s.expires_at, ?), 1, ?
    FROM sessions s JOIN users u ON u.id = s.user_id AND u.kind = 'human'
    JOIN publisher_clients pc ON pc.user_id = u.id AND pc.workspace_id = u.workspace_id
    WHERE s.token = ? AND s.expires_at > ? AND pc.id = ?
      AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.workspace_id = pc.workspace_id AND m.status = 'removed')`)
    .bind(
      new Date(Date.now() + 600000).toISOString(),
      now,
      sessionToken,
      now,
      intent.selectedPublisherClientId,
    )
    .run()
  return result.meta.changes === 1
}
