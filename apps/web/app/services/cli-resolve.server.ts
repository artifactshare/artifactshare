import { sql, type Kysely } from 'kysely'
import { displayTitle } from '~/lib/display-title'
import type { ArtifactKind, Visibility } from '~/lib/shareable-types'
import {
  listWorkspaceProjects,
  type ProjectSummary,
  visibleShareableToViewer,
} from './projects.server'
import type { DB } from '~/types/db'

const RESOLVE_LIMIT = 10

type UserContext = {
  id: string
  email: string
  emailVerified: boolean
  workspaceId: string
}

type MatchKind = 'url' | 'id' | 'title' | 'project_name'

type Match = {
  kind: MatchKind
  confidence: 'exact' | 'candidate'
}

type ArtifactCandidate = {
  kind: 'artifact'
  id: string
  title: string
  artifact_kind: ArtifactKind
  visibility: Visibility
  project: { id: string; name: string } | null
  owner: { id: string; email: string }
  updated_at: string
  match: Match
}

type VersionCandidate = {
  kind: 'version'
  id: string
  artifact_id: string
  version_id: string
  ordinal: number
  is_current: boolean
  published_at: string | null
  size_bytes: number
  match: Match
}

type ProjectCandidate = {
  kind: 'project'
  id: string
  name: string
  description: string | null
  base_visibility: string
  file_count: number
  updated_at: string
  match: Match
}

export type CliResolveCandidate =
  | ArtifactCandidate
  | VersionCandidate
  | ProjectCandidate

export type CliResolveResult = {
  query: string
  candidates: CliResolveCandidate[]
  has_more: boolean
}

type ArtifactRow = {
  id: string
  name: string
  derived_title: string | null
  title_override: string | null
  artifact_kind: ArtifactKind
  visibility: Visibility
  updated_at: string
  project_id: string | null
  project_name: string | null
  project_kind: string | null
  owner_id: string
  owner_email: string
}

type VersionRow = {
  id: string
  shareable_id: string
  current_version_id: string | null
  published_at: string | null
  size_bytes: number
  ordinal: number | string | bigint
}

export async function resolveCliCandidates(
  db: Kysely<DB>,
  user: UserContext,
  rawQuery: string,
): Promise<CliResolveResult> {
  const query = rawQuery.trim()
  const candidates: CliResolveCandidate[] = []
  const seen = new Set<string>()
  let projects: ProjectSummary[] | null = null
  let exactProjectsChecked = false
  const plainIdentifier = isPlainIdentifier(query)
  const add = (candidate: CliResolveCandidate) => {
    const key = `${candidate.kind}:${candidate.id}`
    if (seen.has(key) || candidates.length >= RESOLVE_LIMIT + 1) return
    seen.add(key)
    candidates.push(candidate)
  }
  const getProjects = async () =>
    (projects ??= await listWorkspaceProjects(db, user.workspaceId, user))

  const urlArtifactId = resolveArtifactIdFromUrl(query)
  if (urlArtifactId) {
    for (const candidate of await artifactCandidates(db, user, {
      kind: 'id',
      value: urlArtifactId,
      match: { kind: 'url', confidence: 'exact' },
    })) {
      add(candidate)
    }
  }

  if (plainIdentifier) {
    for (const candidate of await artifactCandidates(db, user, {
      kind: 'id',
      value: query,
      match: { kind: 'id', confidence: 'exact' },
    })) {
      add(candidate)
    }
    for (const candidate of await versionCandidates(db, user, query)) {
      add(candidate)
    }
    for (const candidate of projectCandidates(
      await getProjects(),
      query,
      true,
    )) {
      add(candidate)
    }
    exactProjectsChecked = true
  }

  for (const candidate of await artifactCandidates(db, user, {
    kind: 'title-exact',
    value: query,
    match: { kind: 'title', confidence: 'exact' },
  })) {
    add(candidate)
  }
  if (!exactProjectsChecked) {
    for (const candidate of projectCandidates(
      await getProjects(),
      query,
      true,
    )) {
      add(candidate)
    }
  }
  for (const candidate of await artifactCandidates(db, user, {
    kind: 'title-partial',
    value: query,
    match: { kind: 'title', confidence: 'candidate' },
  })) {
    add(candidate)
  }
  for (const candidate of projectCandidates(
    await getProjects(),
    query,
    false,
  )) {
    add(candidate)
  }

  const hasMore = candidates.length > RESOLVE_LIMIT
  return {
    query,
    candidates: candidates.slice(0, RESOLVE_LIMIT),
    has_more: hasMore,
  }
}

async function artifactCandidates(
  db: Kysely<DB>,
  user: UserContext,
  filter: {
    kind: 'id' | 'title-exact' | 'title-partial'
    value: string
    match: Match
  },
): Promise<ArtifactCandidate[]> {
  let query = db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id as id',
      'shareables.name as name',
      'shareables.derived_title as derived_title',
      'shareables.title_override as title_override',
      'shareables.artifact_kind as artifact_kind',
      'shareables.visibility as visibility',
      'shareables.updated_at as updated_at',
      'c.id as project_id',
      'c.name as project_name',
      'c.kind as project_kind',
      'users.id as owner_id',
      'users.email as owner_email',
    ])
    .where('shareables.workspace_id', '=', user.workspaceId)
    .where((eb) => visibleShareableToViewer(eb, user))

  if (filter.kind === 'id') {
    query = query.where('shareables.id', '=', filter.value)
  } else if (filter.kind === 'title-exact') {
    query = query.where(titleExactSql(filter.value))
  } else {
    query = query.where(titleLikeSql(filter.value))
  }

  const rows = await query
    .orderBy('shareables.updated_at', 'desc')
    .limit(RESOLVE_LIMIT + 1)
    .execute()

  return rows.map((row) => artifactCandidate(row, filter.match))
}

async function versionCandidates(
  db: Kysely<DB>,
  user: UserContext,
  versionId: string,
): Promise<VersionCandidate[]> {
  const rows = await db
    .selectFrom('versions')
    .innerJoin('shareables', 'shareables.id', 'versions.shareable_id')
    .select((eb) => [
      'versions.id as id',
      'versions.shareable_id as shareable_id',
      'shareables.current_version_id as current_version_id',
      'versions.published_at as published_at',
      'versions.size_bytes as size_bytes',
      eb
        .selectFrom('versions as older')
        .select((sub) => sub.fn.count<number>('older.id').as('count'))
        .whereRef('older.shareable_id', '=', 'versions.shareable_id')
        .where(
          sql<boolean>`(
            older.created_at < versions.created_at
            OR (older.created_at = versions.created_at AND older.id <= versions.id)
          )`,
        )
        .as('ordinal'),
    ])
    .where('versions.id', '=', versionId)
    .where('shareables.workspace_id', '=', user.workspaceId)
    .where((eb) => visibleShareableToViewer(eb, user))
    .limit(RESOLVE_LIMIT + 1)
    .execute()

  return rows.map((row) => ({
    kind: 'version',
    id: row.id,
    artifact_id: row.shareable_id,
    version_id: row.id,
    ordinal: Number(row.ordinal),
    is_current: row.id === row.current_version_id,
    published_at: row.published_at,
    size_bytes: row.size_bytes,
    match: { kind: 'id', confidence: 'exact' },
  }))
}

function projectCandidates(
  projects: ProjectSummary[],
  value: string,
  exact: boolean,
): ProjectCandidate[] {
  const normalized = value.toLowerCase()
  return projects
    .filter((project) => {
      if (project.id === value) return exact
      const name = project.name.toLowerCase()
      return exact ? name === normalized : name.includes(normalized)
    })
    .slice(0, RESOLVE_LIMIT + 1)
    .map((project) => ({
      kind: 'project',
      id: project.id,
      name: project.name,
      description: project.description,
      base_visibility: project.baseVisibility,
      file_count: project.fileCount,
      updated_at: project.fileUpdatedAt ?? project.updatedAt,
      match: {
        kind: project.id === value ? 'id' : 'project_name',
        confidence: exact ? 'exact' : 'candidate',
      },
    }))
}

function artifactCandidate(row: ArtifactRow, match: Match): ArtifactCandidate {
  return {
    kind: 'artifact',
    id: row.id,
    title: displayTitle({
      name: row.name,
      derivedTitle: row.derived_title,
      titleOverride: row.title_override,
    }),
    artifact_kind: row.artifact_kind,
    visibility: row.visibility,
    project:
      row.project_kind === 'project' && row.project_id && row.project_name
        ? { id: row.project_id, name: row.project_name }
        : null,
    owner: { id: row.owner_id, email: row.owner_email },
    updated_at: row.updated_at,
    match,
  }
}

function resolveArtifactIdFromUrl(value: string): string | null {
  let url
  try {
    url = new URL(value)
  } catch {
    try {
      url = new URL(`https://${value}`)
    } catch {
      return null
    }
  }
  const sandboxMatch = url.hostname.match(
    /^([A-Za-z0-9]+)(?:--v-[a-f0-9]+)?\.sandbox\./,
  )
  if (sandboxMatch?.[1]) return sandboxMatch[1]
  const shareMatch = url.pathname.match(/^\/a\/([A-Za-z0-9]+)(?:[./]|$)/)
  return shareMatch?.[1] ?? null
}

function isPlainIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function titleExactSql(value: string) {
  return sql<boolean>`lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)) = ${value.toLowerCase()}`
}

function titleLikeSql(value: string) {
  const term = value.toLowerCase()
  return sql<boolean>`instr(lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)), ${term}) > 0`
}
