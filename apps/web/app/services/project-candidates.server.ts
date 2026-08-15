import { env } from 'cloudflare:workers'
import type { SessionUser } from '~/lib/user'
import { nowIso } from '~/lib/datetime'

export const PROJECT_CANDIDATE_PAGE_SIZE = 20
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
}

export function normalizeProjectCandidateQuery(value: string | null): string {
  return Array.from((value ?? '').trim().replace(/\s+/g, ' '))
    .slice(0, 100)
    .join('')
}

function escapeLike(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
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
    if (
      Object.keys(row).sort().join(',') !== 'id,name,purpose,query' ||
      row.purpose !== purpose ||
      row.query !== query ||
      typeof row.name !== 'string' ||
      typeof row.id !== 'string' ||
      !row.id
    )
      return 'invalid'
    return row as Cursor
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
}): Promise<{ projects: ProjectCandidate[]; nextCursor: string | null }> {
  const { user, purpose, query, cursor } = input
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
  const search = query ? `AND c.name LIKE ? ESCAPE '\\'` : ''
  const seek = cursor
    ? `AND (
        c.name COLLATE NOCASE > ? COLLATE NOCASE
        OR (c.name COLLATE NOCASE = ? COLLATE NOCASE AND c.id > ?)
      )`
    : ''
  const bindings: unknown[] = [user.workspaceId]
  if (purpose === 'agent-approval') bindings.push(user.email)
  if (query) bindings.push(`%${escapeLike(query)}%`)
  if (cursor) bindings.push(cursor.name, cursor.name, cursor.id)
  bindings.push(PROJECT_CANDIDATE_PAGE_SIZE + 1)
  const result = await env.DB.prepare(
    `SELECT c.id, c.name, c.base_visibility, c.updated_at
       FROM artifact_containers c
      WHERE c.workspace_id = ? AND c.kind = 'project' AND c.archived_at IS NULL
        ${permission} ${search} ${seek}
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
  const visible = rows.slice(0, PROJECT_CANDIDATE_PAGE_SIZE)
  const last = visible.at(-1)
  return {
    projects: visible.map((row) => ({
      id: row.id,
      name: row.name,
      baseVisibility: row.base_visibility,
      updatedAt: row.updated_at,
    })),
    nextCursor:
      rows.length > PROJECT_CANDIDATE_PAGE_SIZE && last
        ? encodeCursor({ purpose, query, name: last.name, id: last.id })
        : null,
  }
}
