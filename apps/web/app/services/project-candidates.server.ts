import { env } from 'cloudflare:workers'
import type { SessionUser } from '~/lib/user'
import { nowIso } from '~/lib/datetime'
import { PROJECT_CANDIDATE_SEARCH_THRESHOLD } from '~/lib/project-candidates'
import { loadAgentApprovalContext } from '~/services/cli-device-authority.server'

export const PROJECT_CANDIDATE_PAGE_SIZE = 20
export { PROJECT_CANDIDATE_SEARCH_THRESHOLD }
export type ProjectCandidatePurpose = 'bot-destination' | 'agent-approval'
export type ProjectCandidate = {
  id: string
  name: string
  baseVisibility: 'workspace' | 'private'
  updatedAt: string
}

type Cursor = {
  purpose: ProjectCandidatePurpose
  query: string
  name: string
  id: string
  preferredProjectId: string | null
}

export function normalizeProjectCandidateQuery(value: string | null): string {
  return Array.from((value ?? '').trim().replace(/\s+/g, ' '))
    .slice(0, 100)
    .join('')
}

function encodeCursor(cursor: Cursor): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(cursor))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function decodeProjectCandidateCursor(
  value: string | null,
  purpose: ProjectCandidatePurpose,
  query: string,
): Cursor | null | 'invalid' {
  if (!value) return null
  if (value.length > 2048) return 'invalid'
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const parsed = JSON.parse(
      decodeURIComponent(
        escape(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))),
      ),
    ) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return 'invalid'
    const row = parsed as Record<string, unknown>
    const keys = Object.keys(row).sort().join(',')
    const preferredProjectId =
      row.preferredProjectId === undefined ? null : row.preferredProjectId
    if (
      (keys !== 'id,name,preferredProjectId,purpose,query' &&
        keys !== 'id,name,purpose,query') ||
      row.purpose !== purpose ||
      row.query !== query ||
      typeof row.name !== 'string' ||
      typeof row.id !== 'string' ||
      (preferredProjectId !== null &&
        (typeof preferredProjectId !== 'string' || !preferredProjectId)) ||
      !row.id
    )
      return 'invalid'
    return { ...row, preferredProjectId } as Cursor
  } catch {
    return 'invalid'
  }
}

export async function isWorkspaceAdmin(user: SessionUser): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT role FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  )
    .bind(user.workspaceId, user.id)
    .first<{ role: string }>()
  return row?.role === 'owner' || row?.role === 'admin'
}

export async function isOwnedPendingAgentCode(
  user: SessionUser,
  userCode: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM deviceCode
      WHERE userCode = ? AND userId = ? AND preset = 'agent'
        AND status = 'pending' AND expiresAt > ?`,
  )
    .bind(userCode, user.id, nowIso())
    .first<{ found: number }>()
  return row?.found === 1
}

export async function listProjectCandidates(input: {
  user: SessionUser
  purpose: ProjectCandidatePurpose
  query: string
  cursor: Cursor | null
  userCode?: string
}): Promise<{
  projects: ProjectCandidate[]
  preferredProject: ProjectCandidate | null
  nextCursor: string | null
}> {
  const { user, purpose, query, cursor } = input
  if (purpose === 'agent-approval' && input.userCode) {
    const approval = await loadAgentApprovalContext(
      input.userCode,
      user.id,
      user.workspaceId,
      user.email,
    )
    if (approval?.projectSelector) {
      return {
        projects: approval.fixedProject ? [approval.fixedProject] : [],
        preferredProject: approval.fixedProject,
        nextCursor: null,
      }
    }
  }
  if (PROJECT_CANDIDATE_PAGE_SIZE <= PROJECT_CANDIDATE_SEARCH_THRESHOLD) {
    throw new Error('Project candidate page size must exceed search threshold')
  }
  const permission =
    purpose === 'agent-approval'
      ? `AND (
        c.base_visibility = 'workspace'
        OR EXISTS (
          SELECT 1 FROM project_share_defaults psd
          WHERE psd.project_container_id = c.id
            AND lower(psd.email) = lower(?)
            AND psd.role IN ('contributor', 'manager')
        )
      )`
      : ''
  const search = query ? `AND instr(lower(c.name), lower(?)) > 0` : ''
  const historicalPreferredProjectId = cursor
    ? cursor.preferredProjectId
    : await findPreferredProjectId(user, purpose)
  const preferredProject = cursor
    ? null
    : await findEligibleProject({
        user,
        purpose,
        query,
        projectId: historicalPreferredProjectId,
      })
  const preferredProjectId = cursor
    ? historicalPreferredProjectId
    : (preferredProject?.id ?? null)
  const excludePreferred = preferredProjectId ? 'AND c.id <> ?' : ''
  const seek = cursor
    ? `AND (
        c.name COLLATE NOCASE > ? COLLATE NOCASE
        OR (c.name COLLATE NOCASE = ? COLLATE NOCASE AND c.id > ?)
      )`
    : ''
  const bindings: unknown[] = [user.workspaceId]
  if (purpose === 'agent-approval') bindings.push(user.email)
  if (query) bindings.push(query)
  if (preferredProjectId) bindings.push(preferredProjectId)
  if (cursor) bindings.push(cursor.name, cursor.name, cursor.id)
  bindings.push(PROJECT_CANDIDATE_PAGE_SIZE + 1)
  const result = await env.DB.prepare(
    `SELECT c.id, c.name, c.base_visibility, c.updated_at
       FROM artifact_containers c
      WHERE c.workspace_id = ? AND c.kind = 'project' AND c.archived_at IS NULL
        ${permission} ${search} ${excludePreferred} ${seek}
      ORDER BY c.name COLLATE NOCASE, c.id
      LIMIT ?`,
  )
    .bind(...bindings)
    .all<{
      id: string
      name: string
      base_visibility: 'workspace' | 'private'
      updated_at: string
    }>()
  const rows = result.results
  // Keep the preferred project in the legacy projects array so browser tabs
  // running the previous client bundle can still select it across a deploy.
  // The current client deduplicates it when prepending preferredProject.
  const ordinaryPageSize =
    preferredProject === null
      ? PROJECT_CANDIDATE_PAGE_SIZE
      : PROJECT_CANDIDATE_PAGE_SIZE - 1
  const visible = rows.slice(0, ordinaryPageSize)
  const last = visible.at(-1)
  return {
    projects: [
      ...(preferredProject ? [preferredProject] : []),
      ...visible.map((row) => ({
        id: row.id,
        name: row.name,
        baseVisibility: row.base_visibility,
        updatedAt: row.updated_at,
      })),
    ],
    preferredProject,
    nextCursor:
      rows.length > ordinaryPageSize && last
        ? encodeCursor({
            purpose,
            query,
            name: last.name,
            id: last.id,
            preferredProjectId,
          })
        : null,
  }
}

async function findPreferredProjectId(
  user: SessionUser,
  purpose: ProjectCandidatePurpose,
): Promise<string | null> {
  if (purpose === 'agent-approval') {
    const row = await env.DB.prepare(
      `SELECT project_id
         FROM cli_family_authorities
        WHERE user_id = ? AND workspace_id = ? AND preset = 'agent'
          AND approved_at IS NOT NULL AND project_id IS NOT NULL
        ORDER BY approved_at DESC, created_at DESC, family_id DESC
        LIMIT 1`,
    )
      .bind(user.id, user.workspaceId)
      .first<{ project_id: string }>()
    return row?.project_id ?? null
  }

  const row = await env.DB.prepare(
    `SELECT json_extract(a.detail, '$.project_id') AS project_id
       FROM audit_events a
      WHERE a.workspace_id = ? AND a.actor_user_id = ?
        AND a.action = 'bot.create' AND json_valid(a.detail)
        AND EXISTS (
          SELECT 1 FROM cli_family_authorities fa
          WHERE fa.user_id = a.subject_id AND fa.preset = 'agent'
            AND fa.status = 'active'
            AND fa.approved_at IS NOT NULL
            AND fa.project_id = json_extract(a.detail, '$.project_id')
        )
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 1`,
  )
    .bind(user.workspaceId, user.id)
    .first<{ project_id: string }>()
  return row?.project_id ?? null
}

async function findEligibleProject(input: {
  user: SessionUser
  purpose: ProjectCandidatePurpose
  query: string
  projectId: string | null
}): Promise<ProjectCandidate | null> {
  const { user, purpose, query, projectId } = input
  if (!projectId) return null
  const permission =
    purpose === 'agent-approval'
      ? `AND (
        c.base_visibility = 'workspace'
        OR EXISTS (
          SELECT 1 FROM project_share_defaults psd
          WHERE psd.project_container_id = c.id
            AND lower(psd.email) = lower(?)
            AND psd.role IN ('contributor', 'manager')
        )
      )`
      : ''
  const search = query ? `AND instr(lower(c.name), lower(?)) > 0` : ''
  const bindings: unknown[] = [projectId, user.workspaceId]
  if (purpose === 'agent-approval') bindings.push(user.email)
  if (query) bindings.push(query)
  const row = await env.DB.prepare(
    `SELECT c.id, c.name, c.base_visibility, c.updated_at
       FROM artifact_containers c
      WHERE c.id = ? AND c.workspace_id = ? AND c.kind = 'project'
        AND c.archived_at IS NULL ${permission} ${search}`,
  )
    .bind(...bindings)
    .first<{
      id: string
      name: string
      base_visibility: 'workspace' | 'private'
      updated_at: string
    }>()
  return row
    ? {
        id: row.id,
        name: row.name,
        baseVisibility: row.base_visibility,
        updatedAt: row.updated_at,
      }
    : null
}
