import type { Compilable, Kysely } from 'kysely'
import { sql } from 'kysely'
import { externalGrantDomainSql } from './project-membership.server'
import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { detectArtifactTypeForUpload } from '~/lib/artifact-type'
import { nowIso } from '~/lib/datetime'
import { displayTitle } from '~/lib/display-title'
import { extractTitleFromBytes } from '~/lib/extract-title'
import { MAX_GRANT_EMAILS, normalizeGrantEmail } from '~/lib/grant-emails'
import { lowerEmail } from '~/lib/grant-emails.server'
import { computeFileSha256 } from '~/lib/sha256'
import { isSqliteConstraintError } from '~/lib/d1-errors.server'
import { runD1Batch } from '~/lib/d1-batch.server'
import type {
  ArtifactKind,
  EditableVisibility,
  ProjectBaseVisibility,
  Visibility,
} from '~/lib/shareable-types'
import { visibilityForContainer } from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
import type { DB } from '~/types/db'
import { validateBundlePath } from '../../workers/lib/path-validator'
import { createShareableId } from '~/lib/shareable-id'
import {
  isTeamWorkspaceAdmin,
  MAX_CONTENT_BYTES,
  workspaceAdminQuery,
} from './access.server'
import { resolveGrantUsersByEmail } from './grant-users.server'
import { fetchArtifactSourceBytes } from './content.server'
import {
  artifactCreatedEventQuery,
  versionPublishedEventQuery,
} from './events.server'
import {
  artifactContentType,
  artifactR2Key,
  deleteArtifactsByPrefix,
  deleteArtifact,
  putArtifact,
} from './storage.server'
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  allowsStorageOverage,
} from '~/lib/billing-plan.server'
import { isExternalPostingAllowedForWorkspace } from '~/lib/project-external-posting.server'
import {
  resolveLinkSharingWrite,
  type LinkSharingWriteFailure,
} from './link-sharing.server'
import {
  canEditProjectContainer,
  getOrCreateInboxContainerId,
  INBOX_CONTAINER_NAME,
  listWorkspaceProjects,
  resolveUploadContainer,
} from './projects.server'
import { slackNotificationEnqueueQuery } from './slack-notifications.server'

const MAX_SHAREABLE_ID_ATTEMPTS = 5
const MAX_STATIC_SITE_FILES = 50
const MAX_STATIC_SITE_FILE_BYTES = 10 * 1024 * 1024
const MAX_STATIC_SITE_TOTAL_BYTES = MAX_CONTENT_BYTES
const MAX_STATIC_SITE_PATH_CHARS = 256
const MAX_STATIC_SITE_FOLDER_DEPTH = 10
const MAX_TITLE_OVERRIDE_LENGTH = 200
const VERSION_FILE_INSERT_CHUNK_SIZE = 8
const IGNORED_STATIC_SITE_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])
const IGNORED_STATIC_SITE_PATH_SEGMENTS = new Set(['__MACOSX'])
const CONTRIBUTOR_PENDING_GRACE_MS = 60 * 60 * 1000
const CONTRIBUTOR_GUARDRAIL_LIMIT = 10_000

type UploadOptions = {
  agentProfileId?: string | null
  contributorGuardrailLimit?: number
  linkExpiresAt?: string | null
  slackNotify?: boolean
  auditQuery?: (input: {
    workspaceId: string
    shareableId: string
    createdAt: string
  }) => Compilable<unknown>
}

type NewUploadAccounting = {
  workspaceId: string
  contributorGuardrailLimit: number
}

type ArtifactLiveBinding = {
  getByName(name: string): {
    notifyVersionChanged(currentVersionId: string): Promise<void> | void
  }
}

type BackgroundTaskOptions = {
  waitUntil?: (promise: Promise<unknown>) => void
}

export async function notifyArtifactVersionChanged(
  shareableId: string,
  currentVersionId: string,
  live: ArtifactLiveBinding | undefined = (
    env as { ARTIFACT_LIVE?: ArtifactLiveBinding }
  ).ARTIFACT_LIVE,
): Promise<void> {
  if (!live) return
  try {
    await live.getByName(shareableId).notifyVersionChanged(currentVersionId)
  } catch (err) {
    console.error('artifact_version_live_notify_failed', {
      shareable_id: shareableId,
      current_version_id: currentVersionId,
      err,
    })
  }
}

async function scheduleArtifactVersionChanged(
  shareableId: string,
  currentVersionId: string,
  options?: BackgroundTaskOptions,
): Promise<void> {
  const promise = notifyArtifactVersionChanged(shareableId, currentVersionId)
  if (options?.waitUntil) {
    options.waitUntil(promise)
    return
  }
  await promise
}

function hasConstraintConflictMessage(err: unknown, pattern: RegExp): boolean {
  if (!(err instanceof Error)) return false
  const messages = [err.message]
  if (err.cause instanceof Error) messages.push(err.cause.message)
  return messages.some((message) => pattern.test(message))
}

function hasArtifactKeyConflictMessage(err: unknown): boolean {
  return hasConstraintConflictMessage(
    err,
    /UNIQUE constraint failed: artifact_keys\./i,
  )
}

// The message check covers local SQLite wording; the re-query covers D1
// wrappers that reformat constraint errors (same fallback strategy as
// didShareableIdAppearAfterBatchFailure).
async function didArtifactKeyConflict(
  db: Kysely<DB>,
  err: unknown,
  key: { ownerUserId: string; containerId: string; stableKey: string | null },
): Promise<boolean> {
  if (key.stableKey === null) return false
  if (hasArtifactKeyConflictMessage(err)) return true
  if (!isSqliteConstraintError(err)) return false
  try {
    const row = await db
      .selectFrom('artifact_keys')
      .select('id')
      .where('owner_user_id', '=', key.ownerUserId)
      .where('container_id', '=', key.containerId)
      .where('stable_key', '=', key.stableKey)
      .executeTakeFirst()
    return row !== undefined
  } catch {
    return false
  }
}

function artifactKeyInsertQuery(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    ownerUserId: string
    containerId: string
    stableKey: string
    shareableId: string
    now: string
  },
) {
  return db.insertInto('artifact_keys').values({
    id: nanoid(16),
    workspace_id: args.workspaceId,
    owner_user_id: args.ownerUserId,
    container_id: args.containerId,
    stable_key: args.stableKey,
    shareable_id: args.shareableId,
    created_at: args.now,
    updated_at: args.now,
  })
}

function artifactKeyTouchQuery(db: Kysely<DB>, keyId: string, now: string) {
  return db
    .updateTable('artifact_keys')
    .set({ updated_at: now })
    .where('id', '=', keyId)
}

function hasShareableIdPrimaryKeyConflictMessage(err: unknown): boolean {
  return hasConstraintConflictMessage(
    err,
    /(?:UNIQUE|PRIMARY KEY) constraint failed: shareables\.id/i,
  )
}

async function didShareableIdAppearAfterBatchFailure(
  db: Kysely<DB>,
  shareableId: string,
): Promise<boolean> {
  try {
    const row = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', shareableId)
      .executeTakeFirst()
    return row !== undefined
  } catch {
    return false
  }
}

export interface GrantEntry {
  email: string
  grantedAt: string
  user: {
    id: string
    name: string | null
    image: string | null
    kind?: 'human' | 'bot'
  } | null
}

export type GrantListResult =
  | { kind: 'ok'; grants: GrantEntry[] }
  | { kind: 'not-found' }

export interface GrantLookupEntry {
  email: string
  user: { id: string; name: string | null; image: string | null } | null
}

export type GrantLookupResult =
  | { kind: 'ok'; entries: GrantLookupEntry[] }
  | { kind: 'not-found' }

export type UploadShareableResult =
  | {
      kind: 'ok'
      id: string
      versionId: string
      artifactKind: ArtifactKind
      visibility: Visibility
      linkExpiresAt: string | null
      slackNotificationSuppressed?: true
    }
  | { kind: 'unsupported-type' }
  | { kind: 'invalid-path' }
  | { kind: 'too-large' }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'contributor-limit-exceeded' }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }
  | { kind: 'workspace-unavailable' }
  | { kind: 'invalid-container' }
  | { kind: 'too-many-grants'; limit: number }
  | { kind: 'bot-artifact-grant-unsupported' }
  | { kind: 'id-exhausted' }
  | { kind: 'key-conflict' }
  | LinkSharingWriteFailure

export type UploadStaticSiteBundleResult =
  | {
      kind: 'ok'
      id: string
      versionId: string
      visibility: Visibility
      linkExpiresAt: string | null
      slackNotificationSuppressed?: true
    }
  | { kind: 'too-many-files'; limit: number }
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'file-too-large'; path: string; limitBytes: number }
  | { kind: 'missing-entrypoint' }
  | { kind: 'invalid-path'; path: string; reason: string }
  | { kind: 'path-too-long'; path: string; limitChars: number }
  | { kind: 'path-too-deep'; path: string; limitDepth: number }
  | { kind: 'duplicate-path'; path: string }
  | { kind: 'unsupported-type'; path: string }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'contributor-limit-exceeded' }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }
  | { kind: 'workspace-unavailable' }
  | { kind: 'invalid-container' }
  | { kind: 'too-many-grants'; limit: number }
  | { kind: 'bot-artifact-grant-unsupported' }
  | { kind: 'id-exhausted' }
  | { kind: 'key-conflict' }
  | LinkSharingWriteFailure

export type UpdateStaticSiteBundleResult =
  | { kind: 'ok'; id: string; versionId: string }
  | { kind: 'too-many-files'; limit: number }
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'file-too-large'; path: string; limitBytes: number }
  | { kind: 'missing-entrypoint' }
  | { kind: 'invalid-path'; path: string; reason: string }
  | { kind: 'path-too-long'; path: string; limitChars: number }
  | { kind: 'path-too-deep'; path: string; limitDepth: number }
  | { kind: 'duplicate-path'; path: string }
  | { kind: 'unsupported-type'; path: string }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }

export type StaticSiteBundleUploadSessionResult =
  | { kind: 'ok'; session: StaticSiteBundleUploadSession }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'storage-failed' }
  | { kind: 'invalid-container' }
  | { kind: 'id-exhausted' }

export type StaticSiteBundleVersionUploadSessionResult =
  | { kind: 'ok'; session: StaticSiteBundleUploadSession }
  | { kind: 'not-found' }
  | { kind: 'copy-forbidden' }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'storage-failed' }
  | { kind: 'invalid-container' }

type UploadDestination = {
  containerId: string
  containerKind: 'inbox' | 'project'
  workspaceId: string
  // True only for cross-workspace posting into another workspace's project.
  // Drives accounting: such uploads bill the project's workspace while the
  // upload guardrail remains a separate upload-only concern.
  isExternalPosting: boolean
}

export type CreateVersionResult =
  | { kind: 'ok'; versionId: string; artifactKind: ArtifactKind }
  | { kind: 'not-found' }
  | { kind: 'copy-forbidden' }
  | { kind: 'too-large' }
  | { kind: 'unsupported-type' }
  | { kind: 'invalid-path' }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }
  | { kind: 'invalid-container' }

type AppendVersionResult =
  | CreateVersionResult
  | { kind: 'version-conflict'; currentVersionId: string | null }

export type UpdateShareableResult = CreateVersionResult

export type UpdateShareableMetadataResult =
  | { kind: 'ok'; linkExpiresAt?: string | null }
  | { kind: 'not-found' }
  | LinkSharingWriteFailure

export type MoveDestination =
  | { type: 'inbox' }
  | { type: 'project'; projectId: string }

export type MoveShareableResult =
  | {
      kind: 'ok'
      containerId: string
      containerName: string
      visibility: Visibility
      projectAudienceMayChange: boolean
    }
  | { kind: 'not-found' }
  | { kind: 'invalid-destination' }
  | { kind: 'bot-home-unavailable' }

export type MoveDestinationOption = {
  containerId: string
  name: string
  fileCount: number
  isCurrent: boolean
  baseVisibility: ProjectBaseVisibility
  /** 社外ドメインの関係者数。一括移動の集約警告に使う。 */
  externalCount: number
}

export type MoveDestinationsResult =
  | { kind: 'not-found' }
  | {
      kind: 'ok'
      shareable: { id: string; title: string }
      inbox: { isCurrent: boolean } | null
      projects: MoveDestinationOption[]
    }

export type CommitDialogChangesResult =
  | {
      kind: 'ok'
      visibility: Visibility
      grants: GrantEntry[]
      linkExpiresAt: string | null
    }
  | { kind: 'not-found' }
  | { kind: 'workspace-unavailable' }
  | { kind: 'too-many-grants'; limit: number }
  | { kind: 'bot-artifact-grant-unsupported' }
  | { kind: 'commit-failed' }
  | LinkSharingWriteFailure

export interface CommitDialogChangesPayload {
  visibility?: EditableVisibility
  linkExpiresAt?: string | null
  addEmails?: ReadonlyArray<string>
  removeEmails?: ReadonlyArray<string>
}

export interface EditShareableSettingsPayload {
  title?: string
  visibility?: EditableVisibility
  linkExpiresAt?: string | null
  addEmails?: ReadonlyArray<string>
  removeEmails?: ReadonlyArray<string>
  destination?: MoveDestination
}

export type EditShareableSettingsResult =
  | {
      kind: 'ok'
      shareable: OwnedShareableSummary
    }
  | { kind: 'not-found' }
  | { kind: 'invalid-destination' }
  | { kind: 'bot-home-unavailable' }
  | { kind: 'workspace-unavailable' }
  | { kind: 'too-many-grants'; limit: number }
  | { kind: 'bot-artifact-grant-unsupported' }
  | { kind: 'commit-failed' }
  | LinkSharingWriteFailure

export type DeleteShareableResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'delete-failed' }

export type GenerateShareableIdResult =
  | { kind: 'ok'; id: string }
  | { kind: 'id-exhausted' }

export async function generateUniqueShareableId(
  db: Kysely<DB>,
): Promise<GenerateShareableIdResult> {
  for (let attempt = 0; attempt < MAX_SHAREABLE_ID_ATTEMPTS; attempt++) {
    const candidate = createShareableId()
    const existing = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', candidate)
      .executeTakeFirst()
    if (!existing) return { kind: 'ok', id: candidate }
  }

  return { kind: 'id-exhausted' }
}

export async function listGrants(
  db: Kysely<DB>,
  user: { id: string; email: string; workspaceId: string },
  shareableId: string,
): Promise<GrantListResult> {
  const owned = await findOwnedShareableForGrants(db, user, shareableId)
  if (!owned) return { kind: 'not-found' }
  return {
    kind: 'ok',
    grants: await loadGrantEntries(db, shareableId, user.email),
  }
}

export async function lookupGrantUsers(
  db: Kysely<DB>,
  user: { id: string; email: string; workspaceId: string },
  shareableId: string,
  emails: ReadonlyArray<string>,
): Promise<GrantLookupResult> {
  const owned = await findOwnedShareableForGrants(db, user, shareableId)
  if (!owned) return { kind: 'not-found' }

  const normalized = normalizeGrantEmails(emails, user.email)
  if (normalized.length === 0) return { kind: 'ok', entries: [] }

  return {
    kind: 'ok',
    entries: await resolveGrantUsersByEmail(db, normalized),
  }
}

export async function commitDialogChanges(
  db: Kysely<DB>,
  user: {
    id: string
    email: string
    workspaceId: string
    hd: string | null
    msTenantId?: string | null
  },
  shareableId: string,
  payload: CommitDialogChangesPayload,
): Promise<CommitDialogChangesResult> {
  const owned = await findOwnedShareableForGrants(db, user, shareableId)
  if (!owned) return { kind: 'not-found' }

  let newVisibility = payload.visibility ?? owned.visibility
  if (newVisibility === 'workspace' && !isOrgWorkspace(user)) {
    return { kind: 'workspace-unavailable' }
  }
  newVisibility = visibilityForContainer(newVisibility, owned.container_kind)
  const linkWrite = await resolveLinkSharingWrite(db, {
    workspaceId: owned.workspace_id,
    currentVisibility: owned.visibility,
    currentLinkExpiresAt: owned.link_expires_at,
    nextVisibility: newVisibility,
    requestedLinkExpiresAt: payload.linkExpiresAt,
    now: nowIso(),
  })
  if (linkWrite.kind !== 'ok') return linkWrite

  const addEmails = normalizeGrantEmails(payload.addEmails ?? [], user.email)
  const removeEmails = normalizeGrantEmails(
    payload.removeEmails ?? [],
    user.email,
  ).filter((email) => !addEmails.includes(email))
  let newAddEmails: string[] = []
  let allowedGrantCount = MAX_GRANT_EMAILS
  if (addEmails.length > 0) {
    const currentGrantEmails = new Set(
      await loadGrantEmails(db, shareableId, user.email),
    )
    allowedGrantCount = Math.max(MAX_GRANT_EMAILS, currentGrantEmails.size)
    newAddEmails = addEmails.filter((email) => !currentGrantEmails.has(email))
    const nextGrantEmails = new Set(currentGrantEmails)
    for (const email of removeEmails) nextGrantEmails.delete(email)
    for (const email of addEmails) nextGrantEmails.add(email)
    if (nextGrantEmails.size > allowedGrantCount) {
      return { kind: 'too-many-grants', limit: MAX_GRANT_EMAILS }
    }
  }
  if (await containsBotGrantEmail(db, addEmails)) {
    return { kind: 'bot-artifact-grant-unsupported' }
  }
  const ownerGrantEmail = normalizedEmail(user.email)
  const queries: Compilable<unknown>[] = []
  const now = nowIso()
  if (
    newVisibility !== owned.visibility ||
    linkWrite.linkExpiresAt !== owned.link_expires_at
  ) {
    queries.push(
      db
        .updateTable('shareables')
        .set({
          visibility: newVisibility,
          link_expires_at: linkWrite.linkExpiresAt,
          updated_at: now,
        })
        .where('id', '=', shareableId),
    )
  }
  if (removeEmails.length > 0) {
    queries.push(
      db
        .deleteFrom('shareable_grants')
        .where('shareable_id', '=', shareableId)
        .where(lowerEmail('granted_email'), 'in', removeEmails),
    )
  }
  if (ownerGrantEmail) {
    queries.push(
      db
        .deleteFrom('shareable_grants')
        .where('shareable_id', '=', shareableId)
        .where(lowerEmail('granted_email'), '=', ownerGrantEmail),
    )
  }
  if (addEmails.length > 0) {
    queries.push(
      insertGrantEmailsWithinLimitQuery({
        shareableId,
        emails: addEmails,
        grantedBy: user.id,
        grantedAt: now,
        ownerEmail: user.email,
        limit: allowedGrantCount,
      }),
    )
  }

  if (queries.length > 0) {
    try {
      await runD1Batch(...queries)
    } catch (err) {
      if (addEmails.length > 0 && isSqliteConstraintError(err)) {
        return { kind: 'too-many-grants', limit: MAX_GRANT_EMAILS }
      }
      return { kind: 'commit-failed' }
    }
  }
  if (newAddEmails.length > 0) {
    const committedGrantEmails = new Set(
      await loadGrantEmails(db, shareableId, user.email),
    )
    const missingAdd = newAddEmails.some(
      (email) => !committedGrantEmails.has(email),
    )
    if (missingAdd) {
      if (
        newVisibility !== owned.visibility ||
        linkWrite.linkExpiresAt !== owned.link_expires_at
      ) {
        try {
          await runD1Batch(
            db
              .updateTable('shareables')
              .set({
                visibility: owned.visibility,
                link_expires_at: owned.link_expires_at,
                updated_at: nowIso(),
              })
              .where('id', '=', shareableId),
          )
        } catch {
          return { kind: 'commit-failed' }
        }
      }
      return { kind: 'too-many-grants', limit: MAX_GRANT_EMAILS }
    }
  }

  return {
    kind: 'ok',
    visibility: newVisibility,
    grants: await loadGrantEntries(db, shareableId, user.email),
    linkExpiresAt: linkWrite.linkExpiresAt,
  }
}

export async function uploadShareable(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
    hd: string | null
    msTenantId?: string | null
  },
  file: File,
  visibility: Visibility,
  initialGrantEmails: ReadonlyArray<string> = [],
  containerId: string | null = null,
  stableKey: string | null = null,
  options?: UploadOptions,
): Promise<UploadShareableResult> {
  if (visibility === 'workspace' && !isOrgWorkspace(user)) {
    return { kind: 'workspace-unavailable' }
  }
  return await createNewShareableFromFile(
    db,
    user,
    file,
    visibility,
    initialGrantEmails,
    containerId,
    stableKey,
    options,
  )
}

export async function beginStaticSiteBundleUploadSession(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
    hd?: string | null
  },
  containerId: string | null = null,
  stableKey: string | null = null,
  options?: UploadOptions,
): Promise<StaticSiteBundleUploadSessionResult> {
  // Resolve the destination first: cross-workspace posting bills the project's
  // workspace, so the quota snapshot and R2 prefix below must use the destination.
  const destination = await resolveUploadContainer(
    db,
    user,
    containerId,
    nowIso(),
  )
  if (destination.kind !== 'ok') return destination
  const accounting: NewUploadAccounting = {
    workspaceId: destination.workspaceId,
    contributorGuardrailLimit:
      options?.contributorGuardrailLimit ?? CONTRIBUTOR_GUARDRAIL_LIMIT,
  }

  if (await isWorkspaceAccessRevoked(db, accounting.workspaceId, user.id)) {
    return { kind: 'workspace-access-revoked' }
  }

  const workspaceRow = await db
    .selectFrom('workspaces')
    .select([
      'storage_used_bytes',
      'storage_quota_bytes',
      'plan',
      'stripe_subscription_status',
    ])
    .where('id', '=', accounting.workspaceId)
    .executeTakeFirst()
  if (!workspaceRow) return { kind: 'storage-failed' }

  const generated = await generateUniqueShareableId(db)
  if (generated.kind !== 'ok') return generated
  return {
    kind: 'ok',
    session: new StaticSiteBundleUploadSession(
      db,
      user,
      generated.id,
      quotaRemainingBytesForSession(
        workspaceRow.plan,
        workspaceRow.stripe_subscription_status,
        workspaceRow.storage_used_bytes,
        workspaceRow.storage_quota_bytes,
      ),
      {
        kind: 'create',
        destination,
        stableKey,
        agentProfileId: options?.agentProfileId ?? null,
      },
      accounting,
      options?.slackNotify ?? true,
    ),
  }
}

async function checkExternalVersionUploadAllowed(
  db: Kysely<DB>,
  artifactWorkspaceId: string,
  posterWorkspaceId: string,
): Promise<{ kind: 'ok' } | { kind: 'invalid-container' }> {
  if (artifactWorkspaceId === posterWorkspaceId) {
    return { kind: 'ok' }
  }

  if (!(await isExternalPostingAllowedForWorkspace(db, artifactWorkspaceId))) {
    return { kind: 'invalid-container' }
  }

  return { kind: 'ok' }
}

export async function beginStaticSiteBundleVersionUploadSession(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    workspaceId: string
    hd?: string | null
  },
  shareableId: string,
  touchArtifactKeyId: string | null = null,
  options?: BackgroundTaskOptions,
): Promise<StaticSiteBundleVersionUploadSessionResult> {
  const shareable = await findOwnedShareable(db, user, shareableId)
  if (!shareable) return { kind: 'not-found' }
  if (shareable.artifact_kind !== 'static_site') {
    return { kind: 'copy-forbidden' }
  }
  const externalPosting = await checkExternalVersionUploadAllowed(
    db,
    shareable.workspace_id,
    user.workspaceId,
  )
  if (externalPosting.kind !== 'ok') return externalPosting
  // A version bills the artifact's workspace, not the poster's, and consumes no
  // contributor slot. findOwnedShareable no longer scopes to the poster's
  // workspace, so cross-workspace external posts account storage against the
  // project's workspace.
  const accounting = {
    workspaceId: shareable.workspace_id,
    contributorGuardrailLimit: CONTRIBUTOR_GUARDRAIL_LIMIT,
  }
  if (await isWorkspaceAccessRevoked(db, accounting.workspaceId, user.id)) {
    return { kind: 'workspace-access-revoked' }
  }

  const workspaceRow = await db
    .selectFrom('workspaces')
    .select([
      'storage_used_bytes',
      'storage_quota_bytes',
      'plan',
      'stripe_subscription_status',
    ])
    .where('id', '=', accounting.workspaceId)
    .executeTakeFirst()
  if (!workspaceRow) return { kind: 'storage-failed' }

  return {
    kind: 'ok',
    session: new StaticSiteBundleUploadSession(
      db,
      user,
      shareableId,
      quotaRemainingBytesForSession(
        workspaceRow.plan,
        workspaceRow.stripe_subscription_status,
        workspaceRow.storage_used_bytes,
        workspaceRow.storage_quota_bytes,
      ),
      { kind: 'version', touchArtifactKeyId },
      accounting,
      true,
      options,
    ),
  }
}

export async function updateShareable(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    workspaceId: string
    hd?: string | null
  },
  shareableId: string,
  file: File,
  options?: BackgroundTaskOptions,
): Promise<UpdateShareableResult> {
  return await createVersion({ db, user, shareableId, file, ...options })
}

export async function appendShareable(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    workspaceId: string
    hd?: string | null
  },
  shareableId: string,
  content: string,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<AppendVersionResult> {
  const shareable = await findOwnedShareable(db, user, shareableId)
  if (!shareable) return { kind: 'not-found' }
  if (shareable.artifact_kind === 'static_site')
    return { kind: 'copy-forbidden' }
  const current = await db
    .selectFrom('shareables')
    .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select([
      'shareables.current_version_id',
      'shareables.name',
      'versions.r2_key',
      'versions.artifact_kind',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  if (!current?.current_version_id || !current.r2_key)
    return { kind: 'not-found' }
  const source = await fetchArtifactSourceBytes(current.r2_key)
  if (source.kind !== 'ok') return { kind: 'storage-failed' }
  const sourceBytes = new Uint8Array(source.body)
  let insertAt = sourceBytes.byteLength
  if (current.artifact_kind === 'html_page') {
    for (let index = 0; index + 5 < sourceBytes.byteLength; index += 1) {
      if (
        sourceBytes[index] !== 0x3c ||
        sourceBytes[index + 1] !== 0x2f ||
        (sourceBytes[index + 2] | 0x20) !== 0x62 ||
        (sourceBytes[index + 3] | 0x20) !== 0x6f ||
        (sourceBytes[index + 4] | 0x20) !== 0x64 ||
        (sourceBytes[index + 5] | 0x20) !== 0x79
      ) {
        continue
      }
      let cursor = index + 6
      while (
        cursor < sourceBytes.byteLength &&
        (sourceBytes[cursor] === 0x09 ||
          sourceBytes[cursor] === 0x0a ||
          sourceBytes[cursor] === 0x0c ||
          sourceBytes[cursor] === 0x0d ||
          sourceBytes[cursor] === 0x20)
      ) {
        cursor += 1
      }
      if (sourceBytes[cursor] === 0x3e) insertAt = index
    }
  }
  const file = new File(
    [source.body.slice(0, insertAt), content, source.body.slice(insertAt)],
    current.name,
    {
      type:
        current.artifact_kind === 'markdown_page'
          ? 'text/markdown'
          : 'text/html',
    },
  )
  const result = await createVersion({
    db,
    user,
    shareableId,
    file,
    preserveName: true,
    expectedCurrentVersionId: current.current_version_id,
    waitUntil: options?.waitUntil,
  })
  return result
}

type CreateVersionArgs = {
  db: Kysely<DB>
  user: {
    id: string
    email?: string | null
    workspaceId: string
    hd?: string | null
  }
  shareableId: string
  file: File
  touchArtifactKeyId?: string
  waitUntil?: (promise: Promise<unknown>) => void
  preserveName?: boolean
  expectedCurrentVersionId?: string
  auditQuery?: (input: {
    workspaceId: string
    shareableId: string
    createdAt: string
  }) => Compilable<unknown>
}

export function createVersion(
  args: CreateVersionArgs & { expectedCurrentVersionId: string },
): Promise<AppendVersionResult>
export function createVersion(
  args: CreateVersionArgs & { expectedCurrentVersionId?: undefined },
): Promise<CreateVersionResult>
export async function createVersion(
  args: CreateVersionArgs,
): Promise<AppendVersionResult> {
  const {
    db,
    user,
    shareableId,
    file,
    touchArtifactKeyId,
    waitUntil,
    preserveName,
    expectedCurrentVersionId,
    auditQuery,
  } = args
  const shareable = await findOwnedShareable(db, user, shareableId)
  if (!shareable) return { kind: 'not-found' }
  if (shareable.artifact_kind === 'static_site') {
    return { kind: 'copy-forbidden' }
  }
  const externalPosting = await checkExternalVersionUploadAllowed(
    db,
    shareable.workspace_id,
    user.workspaceId,
  )
  if (externalPosting.kind !== 'ok') return externalPosting
  // A version replaces an existing artifact, so storage / quota / suspension all
  // belong to the workspace that owns the artifact, not the poster's, and no
  // contributor slot is consumed. findOwnedShareable no longer scopes to the
  // poster's workspace, so cross-workspace external posts account storage against
  // the project's workspace.
  const accounting = {
    workspaceId: shareable.workspace_id,
    contributorGuardrailLimit: CONTRIBUTOR_GUARDRAIL_LIMIT,
  }
  if (await isWorkspaceAccessRevoked(db, accounting.workspaceId, user.id)) {
    return { kind: 'workspace-access-revoked' }
  }
  const prepared = await prepareUpload(
    db,
    accounting.workspaceId,
    shareableId,
    file,
  )
  if (prepared.kind !== 'ok') return prepared

  const reserved = await reserveQuota(
    db,
    accounting.workspaceId,
    prepared.sizeBytes,
    prepared.now,
  )
  if (reserved === 'over-quota') return { kind: 'quota-exceeded' }
  if (reserved === 'workspace-missing') {
    console.error('reserve_quota_workspace_missing', {
      workspace_id: accounting.workspaceId,
      shareable_id: shareableId,
    })
    return { kind: 'storage-failed' }
  }

  try {
    await putArtifact(env.BUCKET, prepared.r2Key, prepared.body, {
      contentType: prepared.contentType,
    })
  } catch {
    await releaseQuota(
      db,
      accounting.workspaceId,
      prepared.sizeBytes,
      prepared.now,
    )
    return { kind: 'storage-failed' }
  }

  const versionQueries: Compilable<unknown>[] = []
  if (expectedCurrentVersionId !== undefined) {
    versionQueries.push(
      db
        .insertInto('versions')
        .columns([
          'id',
          'shareable_id',
          'artifact_kind',
          'status',
          'entrypoint_path',
          'r2_key',
          'size_bytes',
          'sha256',
          'created_by_id',
          'created_at',
          'published_at',
        ])
        .expression((eb) =>
          eb
            .selectFrom('shareables')
            .select((sel) => [
              sel.val(prepared.versionId).as('id'),
              sel.val(shareableId).as('shareable_id'),
              sel.val(prepared.artifactKind).as('artifact_kind'),
              sel.val('published').as('status'),
              sel.val(prepared.entrypointPath).as('entrypoint_path'),
              sel.val(prepared.r2Key).as('r2_key'),
              sel.val(prepared.sizeBytes).as('size_bytes'),
              sel.val(prepared.sha256).as('sha256'),
              sel.val(user.id).as('created_by_id'),
              sel.val(prepared.now).as('created_at'),
              sel.val(prepared.now).as('published_at'),
            ])
            .where('id', '=', shareableId)
            .where('current_version_id', '=', expectedCurrentVersionId),
        ),
    )
  } else {
    versionQueries.push(
      db.insertInto('versions').values({
        id: prepared.versionId,
        shareable_id: shareableId,
        artifact_kind: prepared.artifactKind,
        status: 'published',
        entrypoint_path: prepared.entrypointPath,
        r2_key: prepared.r2Key,
        size_bytes: prepared.sizeBytes,
        sha256: prepared.sha256,
        created_by_id: user.id,
        created_at: prepared.now,
        published_at: prepared.now,
      }),
    )
  }
  versionQueries.push(
    db
      .updateTable('shareables')
      .set({
        ...(preserveName ? {} : { name: file.name }),
        artifact_kind: prepared.artifactKind,
        derived_title: prepared.derivedTitle,
        current_version_id: prepared.versionId,
        updated_at: prepared.now,
      })
      .where('id', '=', shareableId)
      .$if(expectedCurrentVersionId !== undefined, (q) =>
        q.where('current_version_id', '=', expectedCurrentVersionId!),
      ),
  )
  if (touchArtifactKeyId !== undefined && touchArtifactKeyId !== null) {
    versionQueries.push(
      artifactKeyTouchQuery(db, touchArtifactKeyId, prepared.now),
    )
  }
  versionQueries.push(
    versionPublishedEventQuery(db, { versionId: prepared.versionId }),
  )
  try {
    if (auditQuery) {
      versionQueries.push(
        auditQuery({
          workspaceId: accounting.workspaceId,
          shareableId,
          createdAt: prepared.now,
        }),
      )
    }
    await runD1Batch(...versionQueries)
  } catch {
    await deleteArtifact(env.BUCKET, prepared.r2Key).catch((err) => {
      console.error('r2_compensation_failed', {
        shareable_id: shareableId,
        r2_key: prepared.r2Key,
        err,
      })
    })
    await releaseQuota(
      db,
      accounting.workspaceId,
      prepared.sizeBytes,
      prepared.now,
    )
    return { kind: 'storage-failed' }
  }

  if (expectedCurrentVersionId !== undefined) {
    const committed = await db
      .selectFrom('versions')
      .select('id')
      .where('id', '=', prepared.versionId)
      .executeTakeFirst()
    if (!committed) {
      const [, , latest] = await Promise.all([
        deleteArtifact(env.BUCKET, prepared.r2Key).catch(() => undefined),
        releaseQuota(
          db,
          accounting.workspaceId,
          prepared.sizeBytes,
          prepared.now,
        ),
        db
          .selectFrom('shareables')
          .select('current_version_id')
          .where('id', '=', shareableId)
          .executeTakeFirst(),
      ])
      return {
        kind: 'version-conflict',
        currentVersionId: latest?.current_version_id ?? null,
      }
    }
  }

  await scheduleArtifactVersionChanged(shareableId, prepared.versionId, {
    waitUntil,
  })

  return {
    kind: 'ok',
    versionId: prepared.versionId,
    artifactKind: prepared.artifactKind,
  }
}

export async function updateShareableMetadata(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
  patch: {
    visibility?: EditableVisibility
    linkExpiresAt?: string | null
    titleOverride?: string | null
  },
): Promise<UpdateShareableMetadataResult> {
  if (
    patch.visibility === undefined &&
    patch.linkExpiresAt === undefined &&
    patch.titleOverride === undefined
  ) {
    return { kind: 'ok' }
  }
  const shareable = await db
    .selectFrom('shareables')
    .select(['workspace_id', 'visibility', 'link_expires_at', 'owner_user_id'])
    .where('id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable) return { kind: 'not-found' }
  // Owner-only, with one extension: workspace admins act as the owner for
  // bot-owned artifacts (a stopped bot's metadata would otherwise be frozen
  // forever). Human-owned artifacts are unaffected.
  const authorized =
    shareable.owner_user_id === user.id ||
    (await isBotOwnedArtifactAdmin(db, user, shareable.owner_user_id))
  if (!authorized) return { kind: 'not-found' }
  const changesLinkSettings =
    patch.visibility !== undefined || patch.linkExpiresAt !== undefined
  const linkWrite = changesLinkSettings
    ? await resolveLinkSharingWrite(db, {
        workspaceId: shareable.workspace_id,
        currentVisibility: shareable.visibility,
        currentLinkExpiresAt: shareable.link_expires_at,
        nextVisibility: patch.visibility ?? shareable.visibility,
        requestedLinkExpiresAt: patch.linkExpiresAt,
        now: nowIso(),
      })
    : { kind: 'ok' as const, linkExpiresAt: shareable.link_expires_at }
  if (linkWrite.kind !== 'ok') return linkWrite
  const set: {
    visibility?: EditableVisibility
    link_expires_at?: string | null
    title_override?: string | null
    updated_at: string
  } = { updated_at: nowIso() }
  if (patch.visibility !== undefined) set.visibility = patch.visibility
  if (
    patch.visibility !== undefined ||
    patch.linkExpiresAt !== undefined ||
    shareable.visibility !== 'link'
  ) {
    set.link_expires_at = linkWrite.linkExpiresAt
  }
  if (patch.titleOverride !== undefined)
    set.title_override = patch.titleOverride

  const result = await db
    .updateTable('shareables')
    .set(set)
    .where('id', '=', shareableId)
    .where('owner_user_id', '=', shareable.owner_user_id)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows) === 0) return { kind: 'not-found' }
  return { kind: 'ok', linkExpiresAt: linkWrite.linkExpiresAt }
}

export async function deleteShareable(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
  },
  shareableId: string,
  options?: { allowManagerDelete?: boolean },
): Promise<DeleteShareableResult> {
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id as id',
      'shareables.workspace_id as workspace_id',
      'shareables.owner_user_id as owner_user_id',
      'shareables.container_id as container_id',
      'shareables.visibility as visibility',
      'shareables.name as name',
      'c.kind as container_kind',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable) return { kind: 'not-found' }

  const allowManagerDelete = options?.allowManagerDelete ?? false
  const isOwner = shareable.owner_user_id === user.id
  let authorized = isOwner
  if (!authorized) {
    authorized = await isBotOwnedArtifactAdmin(
      db,
      user,
      shareable.owner_user_id,
    )
  }
  if (
    !authorized &&
    allowManagerDelete &&
    shareable.container_kind === 'project' &&
    shareable.container_id !== null
  ) {
    authorized = await canManagerDeleteProjectShareable(db, user, {
      shareableId: shareable.id,
      projectContainerId: shareable.container_id,
      projectWorkspaceId: shareable.workspace_id,
      visibility: shareable.visibility,
    })
  }
  if (!authorized) return { kind: 'not-found' }

  // static_site bundles keep all asset keys (CSS / JS / images) in
  // version_files. Fetch them before the D1 batch — CASCADE will drop the rows
  // and we'd lose the keys needed to clean R2.
  const [versions, versionFiles] = await Promise.all([
    db
      .selectFrom('versions')
      .select(['r2_key', 'size_bytes'])
      .where('shareable_id', '=', shareableId)
      .execute(),
    db
      .selectFrom('versions')
      .innerJoin('version_files', 'version_files.version_id', 'versions.id')
      .select('version_files.r2_key')
      .where('versions.shareable_id', '=', shareableId)
      .execute(),
  ])

  // Commit D1 first. If R2 cleanup fails afterwards we leak orphan keys, but
  // the user-visible state (DB) stays consistent. Reversing the order would
  // either leave a row pointing at deleted R2 content, or — when the DB batch
  // fails after R2 succeeds — surface a delete-failed error while content is
  // already gone.
  //
  // Use a SUM(versions WHERE shareable_id=X) subquery for the storage debit
  // rather than the pre-fetched totalSize, so concurrent deletes for the
  // same shareable can't double-debit: the second batch sees SUM=0 (cascade
  // already cleared versions) and subtracts nothing. The delete-event insert is
  // likewise gated on the shareable still existing (INSERT ... SELECT WHERE
  // id = X), so a concurrent delete that already removed the row yields no
  // duplicate audit row.
  const now = nowIso()
  const batch: Compilable<unknown>[] = [
    db
      .updateTable('workspaces')
      .set({
        storage_used_bytes: sql<number>`MAX(storage_used_bytes - COALESCE((SELECT SUM(size_bytes) FROM versions WHERE shareable_id = ${shareableId}), 0), 0)`,
        storage_updated_at: now,
      })
      .where('id', '=', shareable.workspace_id),
  ]
  if (
    shareable.container_kind === 'project' &&
    shareable.container_id !== null
  ) {
    batch.push(
      db
        .insertInto('audit_events')
        .columns([
          'id',
          'workspace_id',
          'actor_user_id',
          'action',
          'subject_type',
          'subject_id',
          'detail',
          'created_at',
        ])
        .expression((eb) =>
          eb
            .selectFrom('shareables')
            .where('id', '=', shareableId)
            .select([
              eb.val(nanoid(16)).as('id'),
              eb.val(shareable.workspace_id).as('workspace_id'),
              eb.val(user.id).as('actor_user_id'),
              eb.val('artifact.delete').as('action'),
              eb.val('shareable').as('subject_type'),
              eb.val(shareable.id).as('subject_id'),
              eb
                .val(
                  JSON.stringify({
                    name: shareable.name,
                    project_container_id: shareable.container_id,
                    owner_user_id: shareable.owner_user_id,
                  }),
                )
                .as('detail'),
              eb.val(now).as('created_at'),
            ]),
        ),
    )
  }
  batch.push(db.deleteFrom('shareables').where('id', '=', shareableId))
  try {
    await runD1Batch(...batch)
  } catch {
    return { kind: 'delete-failed' }
  }

  const allKeys = Array.from(
    new Set([
      ...versions.map((v) => v.r2_key),
      ...versionFiles.map((f) => f.r2_key),
    ]),
  )
  const deleteResults = await Promise.allSettled(
    allKeys.map((key) => deleteArtifact(env.BUCKET, key)),
  )
  deleteResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error('r2_orphan_after_delete', {
        shareable_id: shareableId,
        r2_key: allKeys[index],
        err: result.reason,
      })
    }
  })

  return { kind: 'ok' }
}

// 管理者による投稿成果物の削除可否。外部投稿が許可されたプロジェクトで、対象が manager の
// 閲覧できる成果物 (visibility='project' か本人へ個別共有) のときだけ true。
// visibility='private' の他人の成果物は対象外。canEditProjectContainer が
// 作成者・ワークスペース管理者・role='manager' を一括で判定する。
async function canManagerDeleteProjectShareable(
  db: Kysely<DB>,
  user: { id: string; email?: string | null; emailVerified: boolean },
  target: {
    shareableId: string
    projectContainerId: string
    projectWorkspaceId: string
    visibility: string
  },
): Promise<boolean> {
  if (
    !(await isExternalPostingAllowedForWorkspace(db, target.projectWorkspaceId))
  ) {
    return false
  }

  const email = user.email ?? ''
  const canManage = await canEditProjectContainer(
    db,
    target.projectWorkspaceId,
    target.projectContainerId,
    { id: user.id, email, emailVerified: user.emailVerified },
    { managerRoleEnabled: true },
  )
  if (!canManage) return false

  if (target.visibility === 'project') return true

  // visibility='workspace'/'private' は project 関係者の live 判定では見えないので、
  // 個別共有 (shareable_grants) されている場合だけ管理者が閲覧でき、削除できる。
  const normalized = normalizedEmail(email)
  if (!normalized) return false
  const granted = await db
    .selectFrom('shareable_grants')
    .select('shareable_id')
    .where('shareable_id', '=', target.shareableId)
    .where(lowerEmail('granted_email'), '=', normalized)
    .executeTakeFirst()
  return granted !== undefined
}

// Re-parent a shareable to another container in the same workspace. Only the
// container_id (and updated_at) change: visibility, grants, versions, comments,
// and contributor counts are untouched, and project share defaults are not
// applied to the moved shareable.
export async function moveShareableContainer(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
  destination: MoveDestination,
): Promise<MoveShareableResult> {
  const shareable = await db
    .selectFrom('shareables')
    .select([
      'id',
      'owner_user_id',
      'container_id',
      'visibility',
      'link_expires_at',
    ])
    .where('id', '=', shareableId)
    .where('workspace_id', '=', user.workspaceId)
    .executeTakeFirst()
  if (!shareable) return { kind: 'not-found' }

  // Only the owner or a workspace admin may move it; hide existence otherwise.
  // Bot-owned artifacts accept any workspace admin regardless of plan, same
  // as metadata edit and delete (bots exist on free workspaces too).
  const allowed =
    shareable.owner_user_id === user.id ||
    (await isTeamWorkspaceAdmin(db, user, user.workspaceId)) ||
    (await isBotOwnedArtifactAdmin(db, user, shareable.owner_user_id))
  if (!allowed) return { kind: 'not-found' }

  const now = nowIso()

  let destContainerId: string
  let destName: string
  if (destination.type === 'inbox') {
    // Bots have no home: reject before the implicit inbox creation below
    // would mint one for the bot owner.
    const owner = await db
      .selectFrom('users')
      .select('kind')
      .where('id', '=', shareable.owner_user_id)
      .executeTakeFirst()
    if (owner?.kind === 'bot') return { kind: 'bot-home-unavailable' }
    // Inbox targets the shareable owner's home, so the file returns to its
    // owner's unsorted area rather than the actor's when an admin moves it.
    destContainerId = await getOrCreateInboxContainerId(
      db,
      user.workspaceId,
      shareable.owner_user_id,
      now,
    )
    destName = INBOX_CONTAINER_NAME
  } else {
    const project = await db
      .selectFrom('artifact_containers')
      .select(['id', 'name'])
      .where('id', '=', destination.projectId)
      .where('workspace_id', '=', user.workspaceId)
      .where('kind', '=', 'project')
      .where('archived_at', 'is', null)
      .executeTakeFirst()
    if (!project) return { kind: 'invalid-destination' }
    destContainerId = project.id
    destName = project.name
  }

  const originalContainerId = shareable.container_id
  const moved = originalContainerId !== destContainerId
  let visibility = shareable.visibility
  if (moved) {
    // inbox には関係者がいないため visibility='project' を保てない。inbox へ移す
    // ときは private に落とし、移動前の所有者と個別共有だけが見える状態にする。
    // 別プロジェクトへの移動では 'project' のまま移動先の関係者を参照させる。
    const resetProjectVisibility =
      destination.type === 'inbox' && visibility === 'project'
    if (resetProjectVisibility) visibility = 'private'
    let update = db
      .updateTable('shareables')
      .set({
        container_id: destContainerId,
        updated_at: now,
        ...(resetProjectVisibility
          ? { visibility: 'private' as const, link_expires_at: null }
          : {}),
      })
      .where('id', '=', shareableId)
      .where('workspace_id', '=', user.workspaceId)
    if (destination.type === 'project') {
      // Re-check the destination is still a non-archived project at write time,
      // closing the window between the validation read above and this update
      // where another request could archive it. The owner's inbox is always
      // valid, so only project destinations need the guard.
      update = update.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('artifact_containers')
            .select('id')
            .where('id', '=', destContainerId)
            .where('workspace_id', '=', user.workspaceId)
            .where('kind', '=', 'project')
            .where('archived_at', 'is', null),
        ),
      )
    }
    await runD1Batch(
      update,
      db
        .deleteFrom('project_pins')
        .where('shareable_id', '=', shareableId)
        .where(
          sql<boolean>`EXISTS (SELECT 1 FROM shareables WHERE id = ${shareableId} AND container_id = ${destContainerId})`,
        ),
    )
    const movedShareable = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', shareableId)
      .where('workspace_id', '=', user.workspaceId)
      .executeTakeFirst()
    if (movedShareable?.container_id !== destContainerId) {
      return { kind: 'invalid-destination' }
    }
  }

  return {
    kind: 'ok',
    containerId: destContainerId,
    containerName: destName,
    visibility,
    projectAudienceMayChange:
      shareable.visibility === 'project' &&
      destination.type === 'project' &&
      moved,
  }
}

// Destinations for the move picker: the owner's 未整理 plus the workspace's
// non-archived projects, with the shareable's current container flagged so the
// UI can mark it and block a no-op move.
export async function listMoveDestinations(
  db: Kysely<DB>,
  user: {
    id: string
    workspaceId: string
    email: string
    emailVerified: boolean
  },
  shareableId: string,
): Promise<MoveDestinationsResult> {
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.title_override',
      'shareables.derived_title',
      'shareables.container_id',
      'c.kind as current_kind',
    ])
    .where('shareables.id', '=', shareableId)
    .where('shareables.workspace_id', '=', user.workspaceId)
    .executeTakeFirst()
  if (!shareable) return { kind: 'not-found' }

  const allowed =
    shareable.owner_user_id === user.id ||
    (await isTeamWorkspaceAdmin(db, user, user.workspaceId)) ||
    // Same bot-owner exception as moveShareableContainer, or the move UI
    // 404s on free/plus workspaces while the POST would succeed.
    (await isBotOwnedArtifactAdmin(db, user, shareable.owner_user_id))
  if (!allowed) return { kind: 'not-found' }

  const [projects, externalRows] = await Promise.all([
    listWorkspaceProjects(db, user.workspaceId, {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
    }),
    db
      .selectFrom('project_share_defaults as d')
      .innerJoin('artifact_containers as c', 'c.id', 'd.project_container_id')
      .innerJoin('workspaces as w', 'w.id', 'c.workspace_id')
      .select((eb) => [
        'd.project_container_id as containerId',
        eb.fn.count<number>('d.id').as('externalCount'),
      ])
      .where('c.workspace_id', '=', user.workspaceId)
      .where(externalGrantDomainSql)
      .groupBy('d.project_container_id')
      .execute(),
  ])
  const externalCounts = new Map(
    externalRows.map((r) => [r.containerId, Number(r.externalCount)]),
  )

  return {
    kind: 'ok',
    shareable: {
      id: shareable.id,
      title: displayTitle({
        name: shareable.name,
        derivedTitle: shareable.derived_title,
        titleOverride: shareable.title_override,
      }),
    },
    // Bots have no home: moveShareableContainer rejects the inbox
    // destination for bot-owned artifacts, so don't advertise it.
    inbox:
      (await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', shareable.owner_user_id)
        .where('kind', '=', 'bot')
        .executeTakeFirst()) === undefined
        ? { isCurrent: shareable.current_kind === 'inbox' }
        : null,
    projects: projects.map((p) => ({
      containerId: p.id,
      name: p.name,
      fileCount: p.fileCount,
      isCurrent: p.id === shareable.container_id,
      baseVisibility: p.baseVisibility,
      externalCount: externalCounts.get(p.id) ?? 0,
    })),
  }
}

async function createNewShareableFromFile(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
  },
  file: File,
  visibility: Visibility,
  initialGrantEmails: ReadonlyArray<string>,
  requestedContainerId: string | null,
  stableKey: string | null,
  options?: UploadOptions,
): Promise<UploadShareableResult> {
  const grantEmails = normalizeGrantEmails(
    initialGrantEmails,
    user.email ?? null,
  )
  if (grantEmails.length > MAX_GRANT_EMAILS) {
    return { kind: 'too-many-grants', limit: MAX_GRANT_EMAILS }
  }
  if (await containsBotGrantEmail(db, grantEmails)) {
    return { kind: 'bot-artifact-grant-unsupported' }
  }

  // Resolve the destination before allocating an id or buffering the file:
  // cross-workspace posting bills the project's workspace, so every quota / R2
  // / contributor decision below must use the destination workspace, not the
  // poster's. resolveUploadContainer enforces the workspace policy and
  // relationship for external posting; the contributor guardrail is applied
  // by this upload path after destination resolution.
  const destination = await resolveUploadContainer(
    db,
    user,
    requestedContainerId,
    nowIso(),
  )
  if (destination.kind !== 'ok') return destination
  const accounting: NewUploadAccounting = {
    workspaceId: destination.workspaceId,
    contributorGuardrailLimit:
      options?.contributorGuardrailLimit ?? CONTRIBUTOR_GUARDRAIL_LIMIT,
  }
  const effectiveVisibility = visibilityForContainer(
    visibility,
    destination.containerKind,
  )
  const linkWrite = await resolveLinkSharingWrite(db, {
    workspaceId: destination.workspaceId,
    currentVisibility: null,
    currentLinkExpiresAt: null,
    nextVisibility: effectiveVisibility,
    requestedLinkExpiresAt: options?.linkExpiresAt,
    now: nowIso(),
  })
  if (linkWrite.kind !== 'ok') return linkWrite
  for (let attempt = 0; attempt < MAX_SHAREABLE_ID_ATTEMPTS; attempt++) {
    const generated = await generateUniqueShareableId(db)
    if (generated.kind !== 'ok') return generated
    const shareableId = generated.id
    const prepared = await prepareUpload(
      db,
      accounting.workspaceId,
      shareableId,
      file,
    )
    if (prepared.kind !== 'ok') return prepared

    const contributorReserved = await reserveContributorSlot(
      db,
      accounting.workspaceId,
      user.id,
      prepared.now,
      accounting.contributorGuardrailLimit,
    )
    if (contributorReserved === 'workspace-access-revoked') {
      return { kind: 'workspace-access-revoked' }
    }
    if (contributorReserved === 'over-limit') {
      return { kind: 'contributor-limit-exceeded' }
    }
    if (contributorReserved === 'workspace-missing') {
      console.error('reserve_contributor_workspace_missing', {
        workspace_id: accounting.workspaceId,
        user_id: user.id,
      })
      return { kind: 'storage-failed' }
    }

    const reserved = await reserveQuota(
      db,
      accounting.workspaceId,
      prepared.sizeBytes,
      prepared.now,
    )
    if (reserved === 'over-quota') {
      await releaseContributorSlot(
        db,
        accounting.workspaceId,
        user.id,
        prepared.now,
      )
      return { kind: 'quota-exceeded' }
    }
    if (reserved === 'workspace-missing') {
      console.error('reserve_quota_workspace_missing', {
        workspace_id: accounting.workspaceId,
        shareable_id: shareableId,
      })
      await releaseContributorSlot(
        db,
        accounting.workspaceId,
        user.id,
        prepared.now,
      )
      return { kind: 'storage-failed' }
    }

    try {
      await putArtifact(env.BUCKET, prepared.r2Key, prepared.body, {
        contentType: prepared.contentType,
      })
    } catch {
      await releaseContributorSlot(
        db,
        accounting.workspaceId,
        user.id,
        prepared.now,
      )
      await releaseQuota(
        db,
        accounting.workspaceId,
        prepared.sizeBytes,
        prepared.now,
      )
      return { kind: 'storage-failed' }
    }

    const queries: Compilable<unknown>[] = [
      db.insertInto('shareables').values({
        id: shareableId,
        workspace_id: accounting.workspaceId,
        owner_user_id: user.id,
        slug: null,
        name: file.name,
        derived_title: prepared.derivedTitle,
        title_override: null,
        description: null,
        artifact_kind: prepared.artifactKind,
        visibility: effectiveVisibility,
        link_expires_at: linkWrite.linkExpiresAt,
        current_version_id: prepared.versionId,
        created_at: prepared.now,
        updated_at: prepared.now,
        container_id: destination.containerId,
        last_accessed_at: null,
        created_by_agent_profile_id: options?.agentProfileId ?? null,
      }),
      finalizeContributorSlotQuery(
        db,
        accounting.workspaceId,
        user.id,
        prepared.now,
      ),
      db.insertInto('versions').values({
        id: prepared.versionId,
        shareable_id: shareableId,
        artifact_kind: prepared.artifactKind,
        status: 'published',
        entrypoint_path: prepared.entrypointPath,
        r2_key: prepared.r2Key,
        size_bytes: prepared.sizeBytes,
        sha256: prepared.sha256,
        created_by_id: user.id,
        created_at: prepared.now,
        published_at: prepared.now,
      }),
    ]
    if (grantEmails.length > 0) {
      queries.push(
        insertGrantEmailsQuery(
          db,
          shareableId,
          grantEmails,
          user.id,
          prepared.now,
          {
            ignoreDuplicates: true,
          },
        ),
      )
    }
    if (stableKey !== null) {
      queries.push(
        artifactKeyInsertQuery(db, {
          workspaceId: accounting.workspaceId,
          ownerUserId: user.id,
          containerId: destination.containerId,
          stableKey,
          shareableId,
          now: prepared.now,
        }),
      )
    }
    queries.push(
      artifactCreatedEventQuery(db, { versionId: prepared.versionId }),
    )
    const slackNotification = await slackNotificationEnqueueQuery(db, {
      containerId: destination.containerId,
      visibility: effectiveVisibility,
      slackNotify: options?.slackNotify ?? true,
      shareableId,
      now: prepared.now,
    })
    if (slackNotification.query) queries.push(slackNotification.query)
    try {
      if (options?.auditQuery) {
        queries.push(
          options.auditQuery({
            workspaceId: accounting.workspaceId,
            shareableId,
            createdAt: prepared.now,
          }),
        )
      }
      await runD1Batch(...queries)
    } catch (err) {
      await Promise.all([
        deleteArtifact(env.BUCKET, prepared.r2Key).catch((deleteErr) => {
          console.error('r2_compensation_failed', {
            shareable_id: shareableId,
            r2_key: prepared.r2Key,
            err: deleteErr,
          })
        }),
        releaseContributorSlot(
          db,
          accounting.workspaceId,
          user.id,
          prepared.now,
        ),
        releaseQuota(
          db,
          accounting.workspaceId,
          prepared.sizeBytes,
          prepared.now,
        ),
      ])
      if (
        await didArtifactKeyConflict(db, err, {
          ownerUserId: user.id,
          containerId: destination.containerId,
          stableKey,
        })
      ) {
        return { kind: 'key-conflict' }
      }
      if (
        hasShareableIdPrimaryKeyConflictMessage(err) ||
        (isSqliteConstraintError(err) &&
          (await didShareableIdAppearAfterBatchFailure(db, shareableId)))
      ) {
        console.warn('shareable_id_insert_conflict_retry', {
          shareable_id: shareableId,
          attempt: attempt + 1,
        })
        continue
      }
      return { kind: 'storage-failed' }
    }

    return {
      kind: 'ok',
      id: shareableId,
      versionId: prepared.versionId,
      artifactKind: prepared.artifactKind,
      visibility: effectiveVisibility,
      linkExpiresAt: linkWrite.linkExpiresAt,
      ...(slackNotification.suppressed
        ? { slackNotificationSuppressed: true as const }
        : {}),
    }
  }

  return { kind: 'id-exhausted' }
}

type UploadedStaticSiteFile = {
  id: string
  path: string
  r2Key: string
  mimeType: string
  sizeBytes: number
  sha256: string
  derivedTitle: string | null
}

type StaticSiteAddFileResult =
  | { kind: 'ok' }
  | { kind: 'too-many-files'; limit: number }
  | { kind: 'too-large'; limitBytes: number }
  | { kind: 'file-too-large'; path: string; limitBytes: number }
  | { kind: 'invalid-path'; path: string; reason: string }
  | { kind: 'path-too-long'; path: string; limitChars: number }
  | { kind: 'path-too-deep'; path: string; limitDepth: number }
  | { kind: 'duplicate-path'; path: string }
  | { kind: 'unsupported-type'; path: string }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }

type StaticSiteBundleUploadTarget =
  | {
      kind: 'create'
      destination: UploadDestination
      stableKey: string | null
      agentProfileId: string | null
    }
  | { kind: 'version'; touchArtifactKeyId: string | null }

export class StaticSiteBundleUploadSession {
  readonly shareableId: string
  readonly versionId = nanoid(16)
  readonly now = nowIso()
  readonly r2Prefix: string
  readonly files: UploadedStaticSiteFile[] = []
  #seenPathsLower = new Set<string>()
  #totalSizeBytes = 0
  #closed = false

  constructor(
    private readonly db: Kysely<DB>,
    private readonly user: {
      id: string
      email?: string | null
      workspaceId: string
      hd?: string | null
    },
    shareableId: string,
    private readonly quotaRemainingBytes: number,
    private readonly target: StaticSiteBundleUploadTarget,
    private readonly accounting: NewUploadAccounting,
    private slackNotify = true,
    private readonly notificationOptions: BackgroundTaskOptions = {},
  ) {
    this.shareableId = shareableId
    this.r2Prefix = staticSiteR2Prefix(
      accounting.workspaceId,
      shareableId,
      this.versionId,
    )
  }

  get fileCount(): number {
    return this.files.length
  }

  setSlackNotify(value: boolean): void {
    this.slackNotify = value
  }

  async addFile(file: File): Promise<StaticSiteAddFileResult> {
    if (this.#closed) return { kind: 'storage-failed' }
    if (this.files.length >= MAX_STATIC_SITE_FILES) {
      return { kind: 'too-many-files', limit: MAX_STATIC_SITE_FILES }
    }

    const rawPath = file.name
    if (isIgnoredStaticSiteUploadPath(rawPath)) return { kind: 'ok' }

    const pathValidation = validateBundlePath(rawPath)
    if (pathValidation.kind === 'blocked') {
      return {
        kind: 'invalid-path',
        path: rawPath,
        reason: pathValidation.reason,
      }
    }

    const path = normalizeBundlePath(rawPath)
    const pathProblem = validatePreparedStaticSitePath(
      path,
      this.#seenPathsLower,
    )
    if (pathProblem) return pathProblem

    const mimeType = staticSiteMimeType(path)
    if (!mimeType) return { kind: 'unsupported-type', path }
    if (file.size > MAX_STATIC_SITE_FILE_BYTES) {
      return {
        kind: 'file-too-large',
        path,
        limitBytes: MAX_STATIC_SITE_FILE_BYTES,
      }
    }
    const nextTotalSize = this.#totalSizeBytes + file.size
    if (nextTotalSize > MAX_STATIC_SITE_TOTAL_BYTES) {
      return { kind: 'too-large', limitBytes: MAX_STATIC_SITE_TOTAL_BYTES }
    }
    // Session quota is a best-effort snapshot from begin time. reserveQuota in
    // commit remains the atomic source of truth; concurrent uploads can still
    // fail there after earlier files have been staged to R2.
    if (nextTotalSize > this.quotaRemainingBytes) {
      return { kind: 'quota-exceeded' }
    }

    const body = await file.arrayBuffer()
    const entrypointKind = staticSiteEntrypointKind(path)
    const uploaded: UploadedStaticSiteFile = {
      id: nanoid(16),
      path,
      r2Key: `${this.r2Prefix}${path.slice(1)}`,
      mimeType,
      sizeBytes: file.size,
      sha256: await computeFileSha256(body),
      derivedTitle: entrypointKind
        ? extractTitleFromBytes(body, entrypointKind, {
            shareableId: this.shareableId,
            fileName: path,
          })
        : null,
    }

    try {
      await putArtifact(env.BUCKET, uploaded.r2Key, body, {
        contentType: uploaded.mimeType,
      })
    } catch (err) {
      console.error('static_site_r2_put_failed', {
        shareable_id: this.shareableId,
        version_id: this.versionId,
        path,
        r2_key: uploaded.r2Key,
        err,
      })
      return { kind: 'storage-failed' }
    }

    this.#seenPathsLower.add(path.toLowerCase())
    this.#totalSizeBytes = nextTotalSize
    this.files.push(uploaded)
    return { kind: 'ok' }
  }

  async commit(
    visibility: Visibility,
    initialGrantEmails: ReadonlyArray<string> = [],
    requestedLinkExpiresAt?: string | null,
  ): Promise<UploadStaticSiteBundleResult> {
    if (this.#closed) return { kind: 'storage-failed' }
    this.#closed = true
    if (this.target.kind !== 'create') return { kind: 'storage-failed' }

    const entrypointFile = this.entrypointFile()
    if (!entrypointFile) {
      await this.abortUploadedFiles()
      return { kind: 'missing-entrypoint' }
    }

    const linkWrite = await resolveLinkSharingWrite(this.db, {
      workspaceId: this.accounting.workspaceId,
      currentVisibility: null,
      currentLinkExpiresAt: null,
      nextVisibility: visibility,
      requestedLinkExpiresAt,
      now: this.now,
    })
    if (linkWrite.kind !== 'ok') {
      await this.abortUploadedFiles()
      return linkWrite
    }

    const grantEmails = normalizeGrantEmails(
      initialGrantEmails,
      this.user.email ?? null,
    )
    if (grantEmails.length > MAX_GRANT_EMAILS) {
      await this.abortUploadedFiles()
      return { kind: 'too-many-grants', limit: MAX_GRANT_EMAILS }
    }
    if (await containsBotGrantEmail(this.db, grantEmails)) {
      await this.abortUploadedFiles()
      return { kind: 'bot-artifact-grant-unsupported' }
    }
    const effectiveVisibility = visibilityForContainer(
      visibility,
      this.target.destination.containerKind,
    )

    const contributorReserved = await reserveContributorSlot(
      this.db,
      this.accounting.workspaceId,
      this.user.id,
      this.now,
      this.accounting.contributorGuardrailLimit,
    )
    if (contributorReserved === 'workspace-access-revoked') {
      await this.abortUploadedFiles()
      return { kind: 'workspace-access-revoked' }
    }
    if (contributorReserved === 'over-limit') {
      await this.abortUploadedFiles()
      return { kind: 'contributor-limit-exceeded' }
    }
    if (contributorReserved === 'workspace-missing') {
      console.error('reserve_contributor_workspace_missing', {
        workspace_id: this.accounting.workspaceId,
        user_id: this.user.id,
      })
      await this.abortUploadedFiles()
      return { kind: 'storage-failed' }
    }

    const reserved = await reserveQuota(
      this.db,
      this.accounting.workspaceId,
      this.#totalSizeBytes,
      this.now,
    )
    if (reserved === 'over-quota') {
      await releaseContributorSlot(
        this.db,
        this.accounting.workspaceId,
        this.user.id,
        this.now,
      )
      await this.abortUploadedFiles()
      return { kind: 'quota-exceeded' }
    }
    if (reserved === 'workspace-missing') {
      console.error('reserve_quota_workspace_missing', {
        workspace_id: this.accounting.workspaceId,
        shareable_id: this.shareableId,
      })
      await releaseContributorSlot(
        this.db,
        this.accounting.workspaceId,
        this.user.id,
        this.now,
      )
      await this.abortUploadedFiles()
      return { kind: 'storage-failed' }
    }

    const sha256 = await this.computeBundleSha256()
    const versionFileRows = this.versionFileRows()

    const queries: Compilable<unknown>[] = [
      this.db.insertInto('shareables').values({
        id: this.shareableId,
        workspace_id: this.accounting.workspaceId,
        owner_user_id: this.user.id,
        slug: null,
        name: entrypointFile.derivedTitle ?? entrypointFile.path.slice(1),
        derived_title: entrypointFile.derivedTitle,
        title_override: null,
        description: null,
        artifact_kind: 'static_site',
        visibility: effectiveVisibility,
        link_expires_at: linkWrite.linkExpiresAt,
        current_version_id: this.versionId,
        created_at: this.now,
        updated_at: this.now,
        container_id: this.target.destination.containerId,
        last_accessed_at: null,
        created_by_agent_profile_id: this.target.agentProfileId,
      }),
      finalizeContributorSlotQuery(
        this.db,
        this.accounting.workspaceId,
        this.user.id,
        this.now,
      ),
      this.db.insertInto('versions').values({
        id: this.versionId,
        shareable_id: this.shareableId,
        artifact_kind: 'static_site',
        status: 'published',
        entrypoint_path: entrypointFile.path,
        r2_key: entrypointFile.r2Key,
        size_bytes: this.#totalSizeBytes,
        sha256,
        fallback_to_index:
          staticSiteEntrypointKind(entrypointFile.path) === 'html' ? 1 : 0,
        created_by_id: this.user.id,
        created_at: this.now,
        published_at: this.now,
      }),
      ...chunkArray(versionFileRows, VERSION_FILE_INSERT_CHUNK_SIZE).map(
        (rows) => this.db.insertInto('version_files').values(rows),
      ),
    ]
    if (grantEmails.length > 0) {
      queries.push(
        insertGrantEmailsQuery(
          this.db,
          this.shareableId,
          grantEmails,
          this.user.id,
          this.now,
          { ignoreDuplicates: true },
        ),
      )
    }
    if (this.target.stableKey !== null) {
      queries.push(
        artifactKeyInsertQuery(this.db, {
          workspaceId: this.accounting.workspaceId,
          ownerUserId: this.user.id,
          containerId: this.target.destination.containerId,
          stableKey: this.target.stableKey,
          shareableId: this.shareableId,
          now: this.now,
        }),
      )
    }
    queries.push(
      artifactCreatedEventQuery(this.db, { versionId: this.versionId }),
    )
    const slackNotification =
      this.target.kind === 'create'
        ? await slackNotificationEnqueueQuery(this.db, {
            containerId: this.target.destination.containerId,
            visibility: effectiveVisibility,
            slackNotify: this.slackNotify,
            shareableId: this.shareableId,
            now: this.now,
          })
        : { query: null, suppressed: false }
    if (slackNotification.query) queries.push(slackNotification.query)

    try {
      await runD1Batch(...queries)
    } catch (err) {
      const keyConflict = await didArtifactKeyConflict(this.db, err, {
        ownerUserId: this.user.id,
        containerId: this.target.destination.containerId,
        stableKey: this.target.stableKey,
      })
      if (!keyConflict) {
        console.error('static_site_d1_commit_failed', {
          shareable_id: this.shareableId,
          version_id: this.versionId,
          file_count: this.files.length,
          total_size_bytes: this.#totalSizeBytes,
          err,
        })
      }
      await Promise.all([
        this.abortUploadedFiles(),
        releaseContributorSlot(
          this.db,
          this.accounting.workspaceId,
          this.user.id,
          this.now,
        ),
        releaseQuota(
          this.db,
          this.accounting.workspaceId,
          this.#totalSizeBytes,
          this.now,
        ),
      ])
      return keyConflict ? { kind: 'key-conflict' } : { kind: 'storage-failed' }
    }

    return {
      kind: 'ok',
      id: this.shareableId,
      versionId: this.versionId,
      visibility: effectiveVisibility,
      linkExpiresAt: linkWrite.linkExpiresAt,
      ...(slackNotification.suppressed
        ? { slackNotificationSuppressed: true as const }
        : {}),
    }
  }

  async commitVersion(): Promise<UpdateStaticSiteBundleResult> {
    if (this.#closed) return { kind: 'storage-failed' }
    this.#closed = true
    if (this.target.kind !== 'version') return { kind: 'storage-failed' }

    const entrypointFile = this.entrypointFile()
    if (!entrypointFile) {
      await this.abortUploadedFiles()
      return { kind: 'missing-entrypoint' }
    }

    const reserved = await reserveQuota(
      this.db,
      this.accounting.workspaceId,
      this.#totalSizeBytes,
      this.now,
    )
    if (reserved === 'over-quota') {
      await this.abortUploadedFiles()
      return { kind: 'quota-exceeded' }
    }
    if (reserved === 'workspace-missing') {
      console.error('reserve_quota_workspace_missing', {
        workspace_id: this.accounting.workspaceId,
        shareable_id: this.shareableId,
      })
      await this.abortUploadedFiles()
      return { kind: 'storage-failed' }
    }

    const sha256 = await this.computeBundleSha256()
    const versionFileRows = this.versionFileRows()
    const fallbackToIndex =
      staticSiteEntrypointKind(entrypointFile.path) === 'html' ? 1 : 0

    const versionQueries: Compilable<unknown>[] = [
      this.db
        .insertInto('versions')
        .columns([
          'id',
          'shareable_id',
          'artifact_kind',
          'status',
          'entrypoint_path',
          'r2_key',
          'size_bytes',
          'sha256',
          'fallback_to_index',
          'created_by_id',
          'created_at',
          'published_at',
        ])
        .expression((eb) =>
          eb
            .selectFrom('shareables')
            .select([
              sql<string>`${this.versionId}`.as('id'),
              sql<string>`${this.shareableId}`.as('shareable_id'),
              sql<'static_site'>`'static_site'`.as('artifact_kind'),
              sql<'published'>`'published'`.as('status'),
              sql<string>`${entrypointFile.path}`.as('entrypoint_path'),
              sql<string>`${entrypointFile.r2Key}`.as('r2_key'),
              sql<number>`${this.#totalSizeBytes}`.as('size_bytes'),
              sql<string>`${sha256}`.as('sha256'),
              sql<number>`${fallbackToIndex}`.as('fallback_to_index'),
              sql<string>`${this.user.id}`.as('created_by_id'),
              sql<string>`${this.now}`.as('created_at'),
              sql<string>`${this.now}`.as('published_at'),
            ])
            .where('id', '=', this.shareableId)
            .where('workspace_id', '=', this.accounting.workspaceId)
            .where('owner_user_id', '=', this.user.id)
            .where('artifact_kind', '=', 'static_site'),
        ),
      ...chunkArray(versionFileRows, VERSION_FILE_INSERT_CHUNK_SIZE).map(
        (rows) => this.db.insertInto('version_files').values(rows),
      ),
      this.db
        .updateTable('shareables')
        .set({
          name: entrypointFile.derivedTitle ?? entrypointFile.path.slice(1),
          artifact_kind: 'static_site',
          derived_title: entrypointFile.derivedTitle,
          current_version_id: this.versionId,
          updated_at: this.now,
        })
        .where('id', '=', this.shareableId)
        .where('workspace_id', '=', this.accounting.workspaceId)
        .where('owner_user_id', '=', this.user.id)
        .where('artifact_kind', '=', 'static_site'),
    ]
    if (this.target.touchArtifactKeyId !== null) {
      versionQueries.push(
        artifactKeyTouchQuery(
          this.db,
          this.target.touchArtifactKeyId,
          this.now,
        ),
      )
    }
    versionQueries.push(
      versionPublishedEventQuery(this.db, { versionId: this.versionId }),
    )
    try {
      await runD1Batch(...versionQueries)
    } catch (err) {
      console.error('static_site_version_d1_commit_failed', {
        shareable_id: this.shareableId,
        version_id: this.versionId,
        file_count: this.files.length,
        total_size_bytes: this.#totalSizeBytes,
        err,
      })
      await this.abortUploadedFiles()
      await releaseQuota(
        this.db,
        this.accounting.workspaceId,
        this.#totalSizeBytes,
        this.now,
      )
      return { kind: 'storage-failed' }
    }

    await scheduleArtifactVersionChanged(
      this.shareableId,
      this.versionId,
      this.notificationOptions,
    )

    return { kind: 'ok', id: this.shareableId, versionId: this.versionId }
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.abortUploadedFiles()
  }

  private async abortUploadedFiles(): Promise<void> {
    await compensateStaticSiteR2(this.r2Prefix, this.shareableId)
  }

  private entrypointFile() {
    return (
      this.files.find((file) => file.path.toLowerCase() === '/index.html') ??
      this.files.find((file) => file.path.toLowerCase() === '/index.md') ??
      null
    )
  }

  private async computeBundleSha256(): Promise<string> {
    return await computeFileSha256(
      new TextEncoder().encode(
        this.files
          .map((file) => `${file.path}\0${file.sizeBytes}\0${file.sha256}`)
          .sort()
          .join('\n'),
      ).buffer,
    )
  }

  private versionFileRows() {
    return this.files.map((file) => ({
      id: file.id,
      version_id: this.versionId,
      path: file.path,
      r2_key: file.r2Key,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      sha256: file.sha256,
      scan_flags: null,
      created_at: this.now,
    }))
  }
}

async function compensateStaticSiteR2(
  r2Prefix: string,
  shareableId: string,
): Promise<void> {
  await deleteArtifactsByPrefix(env.BUCKET, r2Prefix).catch((err) => {
    console.error('r2_compensation_failed', {
      shareable_id: shareableId,
      r2_prefix: r2Prefix,
      err,
    })
  })
}

// Normalize an uploaded file path into the form we store and use as the
// suffix of an R2 key. Collapses repeated `/`, drops `.` segments, strips
// trailing `/`, applies NFC Unicode normalization, and ensures a leading `/`.
// `..` segments are rejected upstream by validateBundlePath so are not
// expected to appear here.
function normalizeBundlePath(path: string): string {
  const slashOnly = path.replaceAll('\\', '/')
  const segments = slashOnly.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 1) {
    const lower = segments[0].toLowerCase()
    if (lower === 'index.html' || lower === 'index.md') {
      segments[0] = lower
    }
  }
  return `/${segments.join('/')}`.normalize('NFC')
}

function bundleFolderDepth(path: string): number {
  return Math.max(path.split('/').filter(Boolean).length - 1, 0)
}

function validatePreparedStaticSitePath(
  path: string,
  seenPathsLower: ReadonlySet<string>,
):
  | { kind: 'path-too-long'; path: string; limitChars: number }
  | { kind: 'path-too-deep'; path: string; limitDepth: number }
  | { kind: 'duplicate-path'; path: string }
  | null {
  if (path.length > MAX_STATIC_SITE_PATH_CHARS) {
    return {
      kind: 'path-too-long',
      path,
      limitChars: MAX_STATIC_SITE_PATH_CHARS,
    }
  }
  if (bundleFolderDepth(path) > MAX_STATIC_SITE_FOLDER_DEPTH) {
    return {
      kind: 'path-too-deep',
      path,
      limitDepth: MAX_STATIC_SITE_FOLDER_DEPTH,
    }
  }
  if (seenPathsLower.has(path.toLowerCase())) {
    return { kind: 'duplicate-path', path }
  }
  return null
}

function staticSiteR2Prefix(
  workspaceId: string,
  shareableId: string,
  versionId: string,
): string {
  return `${workspaceId}/${shareableId}/${versionId}/`
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function staticSiteMimeType(path: string): string | null {
  const extension = path.toLowerCase().match(/\.[^.\\/]+$/)?.[0]
  switch (extension) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.xml':
      return 'application/xml; charset=utf-8'
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8'
    case '.map':
      return 'application/json; charset=utf-8'
    case '.data':
      return 'application/octet-stream'
    case '.rsc':
      return 'text/x-component; charset=utf-8'
    case '.meta':
      return 'text/plain; charset=utf-8'
    case '.md':
    case '.markdown':
      return 'text/markdown; charset=utf-8'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.avif':
      return 'image/avif'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return null
  }
}

function isIgnoredStaticSiteUploadPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.at(-1) ?? path
  return (
    IGNORED_STATIC_SITE_FILE_NAMES.has(fileName) ||
    segments.some((segment) => IGNORED_STATIC_SITE_PATH_SEGMENTS.has(segment))
  )
}

function staticSiteEntrypointKind(path: string): 'html' | 'md' | null {
  switch (path.toLowerCase()) {
    case '/index.html':
      return 'html'
    case '/index.md':
      return 'md'
    default:
      return null
  }
}

async function prepareUpload(
  db: Kysely<DB>,
  workspaceId: string,
  shareableId: string,
  file: File,
) {
  if (file.size > MAX_CONTENT_BYTES) return { kind: 'too-large' } as const

  const renderType = detectArtifactTypeForUpload(file.type, file.name)
  if (!renderType) return { kind: 'unsupported-type' } as const
  const pathValidation = validateBundlePath(file.name)
  if (pathValidation.kind === 'blocked') {
    return { kind: 'invalid-path' } as const
  }

  // Broad pre-check before allocating the 25 MB buffer / running SHA-256 /
  // UTF-8 decode. reserveQuota stays the atomic source of truth; this SELECT
  // is best-effort. Two consequences are accepted by design:
  // - The inequality below must stay the strict negation of reserveQuota's
  //   `<= storage_quota_bytes` WHERE. Keep `>` here in sync if the SQL side
  //   changes; otherwise the pre-check and the atomic check disagree at the
  //   equality boundary.
  // - A concurrent delete / releaseQuota that frees space between this SELECT
  //   and reserveQuota's UPDATE can produce a false reject (retry succeeds).
  //   Accepted to keep the optimization simple; the UX cost is one retry.
  // Active paid-plan overage bypasses the hard quota limit, so skip the
  // pre-check for that path; reserveQuota still accounts bytes unconditionally.
  const workspaceRow = await db
    .selectFrom('workspaces')
    .select([
      'storage_used_bytes',
      'storage_quota_bytes',
      'plan',
      'stripe_subscription_status',
    ])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  if (
    workspaceRow &&
    shouldEnforceStorageQuotaPreCheck(
      workspaceRow.plan,
      workspaceRow.stripe_subscription_status,
    ) &&
    workspaceRow.storage_used_bytes + file.size >
      workspaceRow.storage_quota_bytes
  ) {
    return { kind: 'quota-exceeded' } as const
  }

  const buffer = await file.arrayBuffer()
  const derivedTitle = extractTitleFromBytes(buffer, renderType, {
    shareableId,
    fileName: file.name,
  })
  const sha256 = await computeFileSha256(buffer)
  const versionId = nanoid(16)
  const now = new Date().toISOString()
  const artifactKind: ArtifactKind =
    renderType === 'md' ? 'markdown_page' : 'html_page'
  const entrypointPath = normalizeBundlePath(file.name)
  return {
    kind: 'ok' as const,
    versionId,
    now,
    body: buffer,
    sha256,
    sizeBytes: file.size,
    contentType: artifactContentType(renderType),
    artifactKind,
    entrypointPath,
    r2Key: artifactR2Key({ shareableId, versionId, renderType }),
    derivedTitle,
  }
}

async function reserveContributorSlot(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
  limit: number,
): Promise<
  'ok' | 'workspace-access-revoked' | 'over-limit' | 'workspace-missing'
> {
  await cleanupStaleContributorReservations(db, workspaceId, now)
  if (await isWorkspaceAccessRevoked(db, workspaceId, userId)) {
    return 'workspace-access-revoked'
  }
  // Bots bypass the contributor slot machinery as a set (reserve, finalize,
  // release are all kind-aware) so they never enter the guardrail
  // denominator. The removed-member / stopped-bot check above keeps the
  // stopped-bot rejection at the reserve position, before any R2 write.
  const uploader = await db
    .selectFrom('users')
    .select('kind')
    .where('id', '=', userId)
    .executeTakeFirst()
  if (uploader?.kind === 'bot') return 'ok'

  // Existing contributors remain eligible; only a new contributor consumes the
  // upload guardrail slot. External posting still records the contributor in the
  // project's workspace.
  // Defense in depth: even a manually seeded bot member row never counts
  // toward the contributor guardrail denominator.
  const contributorCountPredicate = sql`
    status != 'removed'
    AND (
      first_contributed_at IS NOT NULL
      OR pending_uploads > 0
    )
    AND EXISTS (
      SELECT 1 FROM users
      WHERE users.id = workspace_members.user_id
        AND users.kind = 'human'
    )`
  const contributorGuardrailGate = sql`
      AND (
        EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = ${workspaceId}
            AND user_id = ${userId}
            AND ${contributorCountPredicate}
        )
        OR (
          SELECT COUNT(*) FROM workspace_members
          WHERE workspace_id = ${workspaceId}
            AND ${contributorCountPredicate}
        ) < ${limit}
      )`

  const result = await sql`
    INSERT INTO workspace_members (
      workspace_id,
      user_id,
      role,
      status,
      first_contributed_at,
      last_contributed_at,
      pending_uploads,
      removed_at,
      removed_by,
      created_at,
      updated_at
    )
    SELECT
      ${workspaceId},
      ${userId},
      'member',
      'active',
      NULL,
      NULL,
      1,
      NULL,
      NULL,
      ${now},
      ${now}
    WHERE EXISTS (
      SELECT 1 FROM workspaces WHERE id = ${workspaceId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = 'removed'
    )${contributorGuardrailGate}
    ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      pending_uploads = pending_uploads + 1,
      updated_at = ${now}
      WHERE workspace_members.status != 'removed'
  `.execute(db)
  if (Number(result.numAffectedRows ?? 0n) === 1) {
    return 'ok'
  }

  if (await isWorkspaceAccessRevoked(db, workspaceId, userId)) {
    return 'workspace-access-revoked'
  }

  const exists = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return exists ? 'over-limit' : 'workspace-missing'
}

/**
 * Artifact-level individual grants never target bots: the agent read
 * predicate only consults workspace visibility and project audiences, so such
 * a grant would silently do nothing. Rejecting it avoids the misleading
 * no-op. Returns true when any of the emails belongs to a bot user.
 */
async function containsBotGrantEmail(
  db: Kysely<DB>,
  emails: ReadonlyArray<string>,
): Promise<boolean> {
  if (emails.length === 0) return false
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('kind', '=', 'bot')
    .where(
      sql<boolean>`lower(email) IN (${sql.join(emails.map((email) => sql`${email.toLowerCase()}`))})`,
    )
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Workspace admins act as the owner of bot-owned artifacts (metadata edit,
 * delete, move) so a stopped bot's output stays manageable.
 */
async function isBotOwnedArtifactAdmin(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  ownerUserId: string,
): Promise<boolean> {
  const owner = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', ownerUserId)
    .where('kind', '=', 'bot')
    .where('workspace_id', '=', user.workspaceId)
    .executeTakeFirst()
  if (!owner) return false
  // Plan-independent: bots exist on free workspaces too, and a stopped bot's
  // artifacts must stay manageable there as well.
  const admin = await workspaceAdminQuery(
    db,
    user.id,
    user.workspaceId,
  ).executeTakeFirst()
  return Boolean(admin)
}

async function isWorkspaceAccessRevoked(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const member = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('status', '=', 'removed')
    .executeTakeFirst()
  if (member !== undefined) return true
  const stoppedBot = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('kind', '=', 'bot')
    .where('bot_stopped_at', 'is not', null)
    .executeTakeFirst()
  return stoppedBot !== undefined
}

async function cleanupStaleContributorReservations(
  db: Kysely<DB>,
  workspaceId: string,
  now: string,
): Promise<void> {
  const cutoff = new Date(
    new Date(now).getTime() - CONTRIBUTOR_PENDING_GRACE_MS,
  ).toISOString()
  await db
    .updateTable('workspace_members')
    .set({ pending_uploads: 0, updated_at: now })
    .where('workspace_id', '=', workspaceId)
    .where('first_contributed_at', 'is', null)
    .where('pending_uploads', '>', 0)
    .where('updated_at', '<', cutoff)
    .execute()
}

function finalizeContributorSlotQuery(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
): Compilable<unknown> {
  return (
    db
      .updateTable('workspace_members')
      .set({
        pending_uploads: sql<number>`MAX(pending_uploads - 1, 0)`,
        first_contributed_at: sql<string>`COALESCE(first_contributed_at, ${now})`,
        last_contributed_at: now,
        updated_at: now,
      })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      // Paired with the bot bypass in reserveContributorSlot: finalize must
      // never set first_contributed_at on a bot member row.
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM users WHERE users.id = ${userId} AND users.kind = 'human')`,
      )
  )
}

async function releaseContributorSlot(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
): Promise<void> {
  await sql`
    UPDATE workspace_members
    SET pending_uploads = MAX(pending_uploads - 1, 0),
        updated_at = ${now}
    WHERE workspace_id = ${workspaceId}
      AND user_id = ${userId}
      AND EXISTS (
        SELECT 1 FROM users WHERE users.id = ${userId} AND users.kind = 'human'
      )
  `.execute(db)
}

// Reserve quota atomically: increments storage_used_bytes only if the
// post-increment value would still fit under the workspace quota. Team plan
// allows overage unconditionally. The conditional WHERE makes concurrent
// uploads race on a single-row UPDATE rather than on a SELECT-then-UPDATE
// TOCTOU. Returns 'workspace-missing' when the workspace row is absent (auth
// state / DB skew) so callers don't mis-report it as 'over-quota' — the two
// states need different UX and ops signals.
function quotaRemainingBytesForSession(
  plan: string | null | undefined,
  subscriptionStatus: string,
  storageUsedBytes: number,
  storageQuotaBytes: number,
): number {
  if (allowsStorageOverage(plan, subscriptionStatus)) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.max(storageQuotaBytes - storageUsedBytes, 0)
}

function shouldEnforceStorageQuotaPreCheck(
  plan: string | null | undefined,
  subscriptionStatus: string,
): boolean {
  return !allowsStorageOverage(plan, subscriptionStatus)
}

async function reserveQuota(
  db: Kysely<DB>,
  workspaceId: string,
  sizeBytes: number,
  now: string,
): Promise<'ok' | 'over-quota' | 'workspace-missing'> {
  const activeStatuses = sql.join(
    ACTIVE_SUBSCRIPTION_STATUSES.map((status) => sql`${status}`),
  )
  // Active paid plans are unbounded; inactive paid plans and Free use the
  // stored included quota.
  const result = await sql`
    UPDATE workspaces
    SET storage_used_bytes = storage_used_bytes + ${sizeBytes},
        storage_updated_at = ${now}
    WHERE id = ${workspaceId}
      AND (
        (plan IN ('plus', 'team') AND stripe_subscription_status IN (${activeStatuses}))
        OR storage_used_bytes + ${sizeBytes} <= storage_quota_bytes
      )
  `.execute(db)
  if (Number(result.numAffectedRows ?? 0n) === 1) return 'ok'

  const exists = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return exists ? 'over-quota' : 'workspace-missing'
}

async function releaseQuota(
  db: Kysely<DB>,
  workspaceId: string,
  sizeBytes: number,
  now: string,
): Promise<void> {
  await sql`
    UPDATE workspaces
    SET storage_used_bytes = MAX(storage_used_bytes - ${sizeBytes}, 0),
        storage_updated_at = ${now}
    WHERE id = ${workspaceId}
  `.execute(db)
}

async function findOwnedShareable(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
) {
  return (
    (await db
      .selectFrom('shareables')
      .select(['id', 'workspace_id', 'current_version_id', 'artifact_kind'])
      .where('id', '=', shareableId)
      .where('owner_user_id', '=', user.id)
      .executeTakeFirst()) ?? null
  )
}

export interface OwnedShareableSummary {
  id: string
  title: string
  visibility: Visibility
  linkExpiresAt: string | null
  updatedAt: string
  // The project the artifact is filed under, or null when it sits in the
  // unfiled inbox (or has no container). Lets the MCP edit_artifact /
  // list_artifacts tools report and filter by placement without a second read.
  projectId: string | null
  artifactKind: ArtifactKind
}

const OWNED_SHAREABLE_LIST_LIMIT = 50

// Owner-scoped summary read, joined to the container so placement comes back in
// the same query. The inbox container has kind 'inbox', so only a 'project'
// container yields a project id; everything else is the unfiled inbox.
function ownedShareableSummaryQuery(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
) {
  return db
    .selectFrom('shareables')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id as id',
      'shareables.name as name',
      'shareables.derived_title as derived_title',
      'shareables.title_override as title_override',
      'shareables.visibility as visibility',
      'shareables.artifact_kind as artifact_kind',
      'shareables.link_expires_at as link_expires_at',
      'shareables.updated_at as updated_at',
      'shareables.container_id as container_id',
      'c.kind as container_kind',
    ])
    .where('shareables.owner_user_id', '=', user.id)
}

function toOwnedShareableSummary(row: {
  id: string
  name: string
  derived_title: string | null
  title_override: string | null
  visibility: Visibility
  artifact_kind: string
  link_expires_at: string | null
  updated_at: string
  container_id: string | null
  container_kind: string | null
}): OwnedShareableSummary {
  return {
    id: row.id,
    title: displayTitle({
      name: row.name,
      derivedTitle: row.derived_title,
      titleOverride: row.title_override,
    }),
    visibility: row.visibility,
    linkExpiresAt: row.link_expires_at,
    updatedAt: row.updated_at,
    projectId: row.container_kind === 'project' ? row.container_id : null,
    artifactKind: row.artifact_kind as ArtifactKind,
  }
}

// The shareables a user owns in their workspace, newest first. Used by the MCP
// `list_artifacts` tool to let an agent pick an update target; bounded so the
// response stays small. `projectId` filters by placement (a project id, or ''
// for the unfiled inbox); `query` is a case-insensitive title substring match.
export async function listOwnedShareables(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  opts: {
    limit?: number
    projectId?: string
    query?: string
    cursor?: { updatedAt: string; id: string }
  } = {},
): Promise<OwnedShareableSummary[]> {
  let qb = ownedShareableSummaryQuery(db, user)
  if (opts.projectId !== undefined) {
    qb = opts.projectId
      ? qb
          .where('shareables.container_id', '=', opts.projectId)
          .where('c.kind', '=', 'project')
      : qb.where('c.kind', '=', 'inbox')
  }
  if (opts.query) {
    // Match displayTitle's precedence; escape LIKE wildcards so a literal % or _
    // in the query isn't treated as a pattern.
    const term = `%${opts.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    qb = qb.where(
      sql<boolean>`lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)) like ${term} escape '\\'`,
    )
  }
  if (opts.cursor) {
    qb = qb.where(
      sql<boolean>`(shareables.updated_at < ${opts.cursor.updatedAt} OR (shareables.updated_at = ${opts.cursor.updatedAt} AND shareables.id < ${opts.cursor.id}))`,
    )
  }
  const rows = await qb
    .orderBy('shareables.updated_at', 'desc')
    .orderBy('shareables.id', 'desc')
    .limit(opts.limit ?? OWNED_SHAREABLE_LIST_LIMIT)
    .execute()
  return rows.map(toOwnedShareableSummary)
}

export async function getOwnedShareableSummary(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
): Promise<OwnedShareableSummary | null> {
  const row = await ownedShareableSummaryQuery(db, user)
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  return row ? toOwnedShareableSummary(row) : null
}

export async function editShareableSettings(
  db: Kysely<DB>,
  user: {
    id: string
    email: string
    workspaceId: string
    hd: string | null
    msTenantId?: string | null
  },
  shareableId: string,
  payload: EditShareableSettingsPayload,
): Promise<EditShareableSettingsResult> {
  const before = await getOwnedShareableSummary(db, user, shareableId)
  if (!before) return { kind: 'not-found' }

  if (payload.destination !== undefined) {
    const moved = await moveShareableContainer(
      db,
      user,
      shareableId,
      payload.destination,
    )
    if (moved.kind !== 'ok') return moved
  }

  if (payload.title !== undefined) {
    const titleOverride =
      payload.title.trim().slice(0, MAX_TITLE_OVERRIDE_LENGTH) || null
    const renamed = await updateShareableMetadata(db, user, shareableId, {
      titleOverride,
    })
    if (renamed.kind !== 'ok') return renamed
  }

  const wantsShareChange =
    payload.visibility !== undefined ||
    payload.linkExpiresAt !== undefined ||
    payload.addEmails !== undefined ||
    payload.removeEmails !== undefined
  if (wantsShareChange) {
    const shared = await commitDialogChanges(db, user, shareableId, {
      visibility: payload.visibility,
      linkExpiresAt: payload.linkExpiresAt,
      addEmails: payload.addEmails,
      removeEmails: payload.removeEmails,
    })
    if (shared.kind !== 'ok') return shared
  }

  let after: OwnedShareableSummary | null = null
  try {
    after = await getOwnedShareableSummary(db, user, shareableId)
  } catch (err) {
    console.error('shareable_edit_summary_failed', { shareableId, err })
  }

  return { kind: 'ok', shareable: after ?? before }
}

// The current version's storage handle for an artifact the user owns. Used by
// the MCP `get_artifact` tool to read the source back. Returns null when the id
// isn't owned in this workspace; the version fields are null when no version is
// current yet (mid-upload) — the caller distinguishes those from a missing row.
export interface OwnedArtifactRef {
  artifactKind: ArtifactKind
  versionId: string | null
  r2Key: string | null
}

export async function getOwnedArtifactRef(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
): Promise<OwnedArtifactRef | null> {
  const row = await db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select([
      'shareables.artifact_kind as artifact_kind',
      'versions.id as version_id',
      'versions.r2_key as r2_key',
    ])
    .where('shareables.id', '=', shareableId)
    .where('shareables.owner_user_id', '=', user.id)
    .executeTakeFirst()
  if (!row) return null
  return {
    // The column is unconstrained TEXT; an unknown value falls through
    // singleFileFormat / renderTypeFromKind to null, so the cast is safe.
    artifactKind: row.artifact_kind as ArtifactKind,
    versionId: row.version_id ?? null,
    r2Key: row.r2_key ?? null,
  }
}

export interface ArtifactVersionSummary {
  versionId: string
  status: string
  sizeBytes: number
  createdAt: string
  publishedAt: string | null
  isCurrent: boolean
}

const OWNED_VERSION_LIST_LIMIT = 50

export interface OwnedArtifactVersions {
  versions: ArtifactVersionSummary[]
  hasMore: boolean
}

// Version history for an artifact the user owns, newest first. Returns null when
// the id isn't owned in this workspace (distinct from an owned artifact with no
// versions, which is an empty list). Versions are retained, so an old artifact
// can exceed the cap; `hasMore` tells the MCP `list_versions` tool whether older
// versions were dropped (probe one past the cap, like listOwnedShareables).
export async function listOwnedArtifactVersions(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
): Promise<OwnedArtifactVersions | null> {
  const owned = await findOwnedShareable(db, user, shareableId)
  if (!owned) return null
  const rows = await db
    .selectFrom('versions')
    .select(['id', 'status', 'size_bytes', 'created_at', 'published_at'])
    .where('shareable_id', '=', shareableId)
    .orderBy('created_at', 'desc')
    // Tiebreaker: rapid updates can share a millisecond timestamp, so order by
    // id too to keep the list (and the has_more cut) deterministic across calls.
    .orderBy('id', 'desc')
    .limit(OWNED_VERSION_LIST_LIMIT + 1)
    .execute()
  const hasMore = rows.length > OWNED_VERSION_LIST_LIMIT
  const shown = hasMore ? rows.slice(0, OWNED_VERSION_LIST_LIMIT) : rows
  return {
    hasMore,
    versions: shown.map((row) => ({
      versionId: row.id,
      status: row.status,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      publishedAt: row.published_at ?? null,
      isCurrent: row.id === owned.current_version_id,
    })),
  }
}

async function findOwnedShareableForGrants(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  shareableId: string,
) {
  return (
    (await db
      .selectFrom('shareables')
      .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
      .select([
        'shareables.id',
        'shareables.workspace_id',
        'shareables.visibility',
        'shareables.link_expires_at',
        'c.kind as container_kind',
      ])
      .where('shareables.id', '=', shareableId)
      .where('shareables.owner_user_id', '=', user.id)
      .executeTakeFirst()) ?? null
  )
}

async function loadGrantEntries(
  db: Kysely<DB>,
  shareableId: string,
  ownerEmail?: string | null,
): Promise<GrantEntry[]> {
  const normalizedOwnerEmail = normalizedEmail(ownerEmail)
  const rows = await db
    .selectFrom('shareable_grants as g')
    // 保存値の大文字小文字は DB 制約では保証されないので、user プロフィール解決の
    // join も両側を小文字化して照合する (素の等価だと大文字混じり行で user=null になる)。
    .leftJoin('users as u', (join) =>
      join.on(
        sql<boolean>`${lowerEmail('u.email')} = ${lowerEmail('g.granted_email')}`,
      ),
    )
    .select([
      'g.granted_email',
      'g.granted_at',
      'u.id as user_id',
      'u.name as user_name',
      'u.image as user_image',
      'u.kind as user_kind',
    ])
    .where('g.shareable_id', '=', shareableId)
    .$if(normalizedOwnerEmail !== null, (qb) =>
      qb.where(lowerEmail('g.granted_email'), '!=', normalizedOwnerEmail!),
    )
    .orderBy('g.granted_at', 'asc')
    .orderBy('g.granted_email', 'asc')
    .execute()

  return rows.map((row) => ({
    email: row.granted_email,
    grantedAt: row.granted_at,
    user: row.user_id
      ? {
          id: row.user_id,
          name: row.user_name,
          image: row.user_image,
          kind: row.user_kind ?? undefined,
        }
      : null,
  }))
}

async function loadGrantEmails(
  db: Kysely<DB>,
  shareableId: string,
  ownerEmail?: string | null,
): Promise<string[]> {
  const normalizedOwnerEmail = normalizedEmail(ownerEmail)
  const rows = await db
    .selectFrom('shareable_grants')
    .select('granted_email')
    .where('shareable_id', '=', shareableId)
    .$if(normalizedOwnerEmail !== null, (qb) =>
      qb.where(lowerEmail('granted_email'), '!=', normalizedOwnerEmail!),
    )
    .execute()

  return rows
    .map((row) => normalizedEmail(row.granted_email))
    .filter((email): email is string => email !== null)
}

function insertGrantEmailsQuery(
  db: Kysely<DB>,
  shareableId: string,
  emails: ReadonlyArray<string>,
  grantedBy: string,
  grantedAt: string,
  opts: { ignoreDuplicates?: boolean } = {},
): Compilable<unknown> {
  const query = db.insertInto('shareable_grants').values(
    emails.map((email) => ({
      shareable_id: shareableId,
      granted_email: email,
      granted_at: grantedAt,
      granted_by: grantedBy,
    })),
  )
  if (!opts.ignoreDuplicates) return query
  return query.onConflict((oc) =>
    oc.columns(['shareable_id', 'granted_email']).doNothing(),
  )
}

function insertGrantEmailsWithinLimitQuery({
  shareableId,
  emails,
  grantedBy,
  grantedAt,
  ownerEmail,
  limit,
}: {
  shareableId: string
  emails: ReadonlyArray<string>
  grantedBy: string
  grantedAt: string
  ownerEmail?: string | null
  limit: number
}): Compilable<unknown> {
  const normalizedOwnerEmail = normalizedEmail(ownerEmail)
  const ownerFilter = normalizedOwnerEmail
    ? 'AND lower(granted_email) != ?'
    : ''
  const parameters: unknown[] = [
    ...emails,
    shareableId,
    ...(normalizedOwnerEmail ? [normalizedOwnerEmail] : []),
    shareableId,
    limit,
    shareableId,
    grantedAt,
    grantedBy,
    shareableId,
    grantedAt,
    grantedBy,
  ]
  return {
    compile: () =>
      ({
        sql: `
    WITH proposed(granted_email) AS (
      VALUES ${emails.map(() => '(?)').join(', ')}
    ),
    current_count(c) AS (
      SELECT COUNT(*)
      FROM shareable_grants
      WHERE shareable_id = ?
      ${ownerFilter}
    ),
    new_count(c) AS (
      SELECT COUNT(*)
      FROM proposed AS p
      WHERE NOT EXISTS (
        SELECT 1
        FROM shareable_grants AS g
        WHERE g.shareable_id = ?
          AND lower(g.granted_email) = p.granted_email
      )
    ),
    limit_check(ok) AS (
      SELECT (SELECT c FROM current_count) + (SELECT c FROM new_count) <= ?
    )
    INSERT OR IGNORE INTO shareable_grants (
      shareable_id,
      granted_email,
      granted_at,
      granted_by
    )
    SELECT ?, p.granted_email, ?, ?
    FROM proposed AS p
    WHERE (SELECT ok FROM limit_check)
    UNION ALL
    SELECT ?, NULL, ?, ?
    WHERE NOT (SELECT ok FROM limit_check)
  `,
        parameters,
      }) as unknown as ReturnType<Compilable<unknown>['compile']>,
  }
}

function normalizeGrantEmails(
  emails: ReadonlyArray<string>,
  ownerEmail?: string | null,
): string[] {
  const normalizedOwnerEmail = normalizedEmail(ownerEmail)
  const result = new Set<string>()
  for (const email of emails) {
    const normalized = normalizeGrantEmail(email)
    if (normalized.length > 0 && normalized !== normalizedOwnerEmail) {
      result.add(normalized)
    }
  }
  return Array.from(result)
}

function normalizedEmail(email?: string | null): string | null {
  const normalized = normalizeGrantEmail(email)
  return normalized.length > 0 ? normalized : null
}
