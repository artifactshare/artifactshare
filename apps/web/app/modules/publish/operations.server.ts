import type { Compilable, Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'
import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'
import { MAX_GRANT_EMAILS, normalizeGrantEmail } from '~/lib/grant-emails'
import { lowerEmail } from '~/lib/grant-emails.server'
import { isSqliteConstraintError } from '~/lib/d1-errors.server'
import { runD1Batch, runD1BatchWithResults } from '~/lib/d1-batch.server'
import type { ArtifactKind, Visibility } from '~/lib/shareable-types'
import { visibilityForContainer } from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
import type { DB } from '~/types/db'
import { isTeamWorkspaceAdmin } from '~/services/access.server'
import { fetchArtifactSourceBytes } from '~/services/content.server'
import type { CliAuthority } from '~/services/cli-authority.server'
import { isAgentPublishableDestination } from '~/services/agent-scope.server'
import {
  artifactCreatedEventQuery,
  versionPublishedEventQuery,
} from '~/services/events.server'
import {
  buildLinkPublishRateLimitFailure,
  isLinkPublicationError,
  linkPublicationAttemptValues,
  resolveLinkSharingWrite,
  type LinkSharingWriteFailure,
} from '~/services/link-sharing.server'
import { isExternalPostingAllowedForWorkspace } from '~/lib/project-external-posting.server'
import { resolveUploadContainer } from '~/services/projects.server'
import { slackNotificationEnqueueQuery } from '~/services/slack-notifications.server'
import { deleteArtifact, putArtifact } from '~/services/storage.server'
import {
  generateUniqueShareableId,
  notifyArtifactVersionChanged,
  prepareUpload,
  releaseQuota,
  reserveQuota,
} from '~/services/shareables.server'

const MAX_SHAREABLE_ID_ATTEMPTS = 5
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

export type CreateVersionResult =
  | { kind: 'ok'; versionId: string; artifactKind: ArtifactKind }
  | { kind: 'version-conflict'; currentVersionId: string | null }
  | { kind: 'not-found' }
  | { kind: 'copy-forbidden' }
  | { kind: 'too-large' }
  | { kind: 'unsupported-type' }
  | { kind: 'invalid-path' }
  | { kind: 'workspace-access-revoked' }
  | { kind: 'quota-exceeded' }
  | { kind: 'storage-failed' }
  | { kind: 'invalid-container' }

type AppendVersionResult = CreateVersionResult

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
  return await createVersion({
    db,
    user,
    shareableId,
    file,
    preserveName: true,
    expectedCurrentVersionId: current.current_version_id,
    waitUntil: options?.waitUntil,
  })
}

type CreateVersionArgs = {
  db: Kysely<DB>
  user: {
    id: string
    email?: string | null
    workspaceId: string
    hd?: string | null
    emailVerified?: boolean
  }
  shareableId: string
  file: File
  touchArtifactKeyId?: string
  waitUntil?: (promise: Promise<unknown>) => void
  preserveName?: boolean
  expectedCurrentVersionId?: string
  authority?: CliAuthority | null
  agentProfileId?: string | null
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
export function createVersion(
  args: CreateVersionArgs,
): Promise<AppendVersionResult>
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
    preserveName: requestedPreserveName,
    expectedCurrentVersionId,
    authority,
    agentProfileId,
    auditQuery,
  } = args
  const shareable = await findWritableShareable(
    db,
    user,
    shareableId,
    authority ?? null,
    'version',
  )
  if (!shareable) return { kind: 'not-found' }
  const preserveArtifactIdentity =
    shareable.owner_user_id !== user.id &&
    shareable.workspace_id !== user.workspaceId
  const preserveName =
    requestedPreserveName ||
    authority?.kind === 'agent' ||
    preserveArtifactIdentity
  const commitExpectedVersionId =
    expectedCurrentVersionId ??
    (authority?.kind === 'agent' || shareable.owner_user_id !== user.id
      ? (shareable.current_version_id ?? undefined)
      : undefined)
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
  if (commitExpectedVersionId !== undefined) {
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
          'created_by_agent_profile_id',
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
              sel.val(agentProfileId ?? null).as('created_by_agent_profile_id'),
              sel.val(prepared.now).as('created_at'),
              sel.val(prepared.now).as('published_at'),
            ])
            .where('id', '=', shareableId)
            .where('current_version_id', '=', commitExpectedVersionId)
            .where(writableShareableSql(user, authority ?? null, 'version')),
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
        created_by_agent_profile_id: agentProfileId ?? null,
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
        ...(preserveArtifactIdentity
          ? {}
          : { derived_title: prepared.derivedTitle }),
        current_version_id: prepared.versionId,
        updated_at: prepared.now,
      })
      .where('id', '=', shareableId)
      .where(writableShareableSql(user, authority ?? null, 'version'))
      .$if(commitExpectedVersionId !== undefined, (q) =>
        q.where('current_version_id', '=', commitExpectedVersionId!),
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
  if (
    !(await findWritableShareable(
      db,
      user,
      shareableId,
      authority ?? null,
      'version',
    ))
  ) {
    await deleteArtifact(env.BUCKET, prepared.r2Key).catch((err) => {
      console.error('unauthorized_version_r2_compensation_failed', {
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
    return { kind: 'not-found' }
  }
  let versionInsertResult: unknown
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
    ;[versionInsertResult] = await runD1BatchWithResults(db, ...versionQueries)
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

  if (commitExpectedVersionId !== undefined) {
    if (batchMutationCount(versionInsertResult) === 0) {
      const [, , writable, latest, externalPostingAfterCommit] =
        await Promise.all([
          deleteArtifact(env.BUCKET, prepared.r2Key).catch(() => undefined),
          releaseQuota(
            db,
            accounting.workspaceId,
            prepared.sizeBytes,
            prepared.now,
          ),
          findWritableShareable(
            db,
            user,
            shareableId,
            authority ?? null,
            'version',
          ),
          db
            .selectFrom('shareables')
            .select('current_version_id')
            .where('id', '=', shareableId)
            .executeTakeFirst(),
          checkExternalVersionUploadAllowed(
            db,
            accounting.workspaceId,
            user.workspaceId,
          ),
        ])
      if (!writable) return { kind: 'not-found' }
      if (externalPostingAfterCommit.kind !== 'ok')
        return externalPostingAfterCommit
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
  const now = nowIso()
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
    now,
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
  let generated = await generateUniqueShareableId(db, now)
  if (generated.kind !== 'ok') return generated
  const linkWrite = await resolveLinkSharingWrite(db, {
    workspaceId: destination.workspaceId,
    shareableId: generated.id,
    currentVisibility: null,
    currentLinkExpiresAt: null,
    nextVisibility: effectiveVisibility,
    requestedLinkExpiresAt: options?.linkExpiresAt,
    now,
  })
  if (linkWrite.kind !== 'ok') return linkWrite
  for (let attempt = 0; attempt < MAX_SHAREABLE_ID_ATTEMPTS; attempt++) {
    const shareableId = generated.id
    const prepared = await prepareUpload(
      db,
      accounting.workspaceId,
      shareableId,
      file,
      file,
      now,
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

    const shareableInsert = db.insertInto('shareables').values({
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
    })
    const attemptValues =
      effectiveVisibility === 'link'
        ? await linkPublicationAttemptValues(db, {
            workspaceId: accounting.workspaceId,
            shareableId,
            now: prepared.now,
          })
        : null
    const queries: Compilable<unknown>[] = []
    if (attemptValues) {
      queries.push(
        db.insertInto('link_publication_attempts').values(attemptValues),
      )
    }
    queries.push(shareableInsert)
    if (attemptValues) {
      queries.push(
        deleteUnconsumedLinkPublicationAttemptQuery(
          db,
          accounting.workspaceId,
          shareableId,
        ),
      )
    }
    queries.push(
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
        created_by_agent_profile_id: options?.agentProfileId ?? null,
        created_at: prepared.now,
        published_at: prepared.now,
      }),
    )
    if (grantEmails.length > 0) {
      queries.push(
        ...insertGrantEmailQueries(
          db,
          shareableId,
          grantEmails,
          user.id,
          prepared.now,
          { ignoreDuplicates: true },
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
      if (attemptValues) {
        queries.push(
          deleteLinkPublicationAttemptQuery(
            db,
            accounting.workspaceId,
            shareableId,
          ),
        )
      }
      await runD1Batch(db, ...queries)
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
      if (isLinkPublicationError(err, 'link publication quota exceeded')) {
        return await buildLinkPublishRateLimitFailure(db, {
          workspaceId: accounting.workspaceId,
          refusedShareableId: shareableId,
          now: prepared.now,
        })
      }
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
        if (attempt + 1 >= MAX_SHAREABLE_ID_ATTEMPTS) break
        generated = await generateUniqueShareableId(db, now)
        if (generated.kind !== 'ok') return generated
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

function batchMutationCount(result: unknown): number {
  const value = Array.isArray(result) ? result[0] : result
  if (!value || typeof value !== 'object') return 0
  if ('numInsertedOrUpdatedRows' in value) {
    return Number(value.numInsertedOrUpdatedRows ?? 0)
  }
  if ('numUpdatedRows' in value) {
    return Number(value.numUpdatedRows ?? 0)
  }
  if ('meta' in value) {
    const meta = value.meta
    if (meta && typeof meta === 'object' && 'changes' in meta) {
      return Number(meta.changes ?? 0)
    }
  }
  return 0
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

function deleteUnconsumedLinkPublicationAttemptQuery(
  db: Kysely<DB>,
  workspaceId: string,
  shareableId: string,
) {
  return db
    .deleteFrom('link_publication_attempts')
    .where('workspace_id', '=', workspaceId)
    .where('shareable_id', '=', shareableId)
    .where('consumed', '=', 0)
}

function deleteLinkPublicationAttemptQuery(
  db: Kysely<DB>,
  workspaceId: string,
  shareableId: string,
) {
  return db
    .deleteFrom('link_publication_attempts')
    .where('workspace_id', '=', workspaceId)
    .where('shareable_id', '=', shareableId)
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

async function scheduleArtifactVersionChanged(
  shareableId: string,
  currentVersionId: string,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<void> {
  const promise = notifyArtifactVersionChanged(shareableId, currentVersionId)
  if (options?.waitUntil) {
    options.waitUntil(promise)
    return
  }
  await promise
}

async function checkExternalVersionUploadAllowed(
  db: Kysely<DB>,
  artifactWorkspaceId: string,
  posterWorkspaceId: string,
): Promise<{ kind: 'ok' } | { kind: 'invalid-container' }> {
  if (artifactWorkspaceId === posterWorkspaceId) return { kind: 'ok' }
  if (!(await isExternalPostingAllowedForWorkspace(db, artifactWorkspaceId))) {
    return { kind: 'invalid-container' }
  }
  return { kind: 'ok' }
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

async function findWritableShareable(
  db: Kysely<DB>,
  user: {
    id: string
    workspaceId: string
    email?: string | null
    emailVerified?: boolean
  },
  shareableId: string,
  authority: CliAuthority | null,
  access: 'collaboration' | 'version' = 'collaboration',
) {
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.current_version_id',
      'shareables.artifact_kind',
      'shareables.visibility',
      'shareables.container_id',
      'c.kind as container_kind',
      'c.base_visibility as container_base_visibility',
      'c.created_by_id as container_created_by_id',
      'c.archived_at as container_archived_at',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable) return null
  if (authority?.kind === 'agent') {
    if (
      !['workspace', 'project'].includes(shareable.visibility) ||
      shareable.container_kind !== 'project' ||
      shareable.container_archived_at !== null ||
      shareable.container_id !== authority.projectId ||
      !(await isAgentPublishableDestination(
        db,
        { workspaceId: user.workspaceId, email: user.email ?? '' },
        authority,
        shareable.container_id,
      ))
    ) {
      return null
    }
    return shareable
  }
  if (authority?.kind === 'bridge') return null
  if (shareable.owner_user_id === user.id) return shareable
  if (user.workspaceId !== shareable.workspace_id) {
    if (access !== 'version' || !user.email || !user.emailVerified) return null
    const externalGrant = await db
      .selectFrom('shareable_grants as external_grant')
      .innerJoin('users as external_user', (join) =>
        join
          .on('external_user.id', '=', user.id)
          .on('external_user.kind', '=', 'human')
          .on('external_user.email_verified', '=', 1),
      )
      .select('external_grant.shareable_id')
      .where('external_grant.shareable_id', '=', shareableId)
      .where(
        lowerEmail('external_grant.granted_email'),
        '=',
        user.email.toLowerCase(),
      )
      .where(lowerEmail('external_user.email'), '=', user.email.toLowerCase())
      .executeTakeFirst()
    return externalGrant ? shareable : null
  }

  const member = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', shareable.workspace_id)
    .where('workspace_members.user_id', '=', user.id)
    .where('workspace_members.status', '=', 'active')
    .where('users.kind', '=', 'human')
    .executeTakeFirst()
  if (!member) return null
  if (
    shareable.visibility === 'workspace' &&
    (shareable.container_kind !== 'project' ||
      shareable.container_archived_at === null)
  )
    return shareable
  if (
    shareable.visibility !== 'project' ||
    shareable.container_kind !== 'project' ||
    shareable.container_archived_at !== null
  ) {
    return null
  }
  if (
    shareable.container_base_visibility === 'workspace' ||
    shareable.container_created_by_id === user.id ||
    (await isTeamWorkspaceAdmin(db, user, shareable.workspace_id))
  ) {
    return shareable
  }
  if (!user.email || !user.emailVerified) return null
  const projectMember = await db
    .selectFrom('project_share_defaults')
    .select('id')
    .where('project_container_id', '=', shareable.container_id!)
    .where(lowerEmail('email'), '=', user.email.toLowerCase())
    .executeTakeFirst()
  return projectMember ? shareable : null
}

function writableShareableSql(
  user: {
    id: string
    workspaceId: string
    email?: string | null
    emailVerified?: boolean
  },
  authority: CliAuthority | null,
  access: 'collaboration' | 'version' = 'collaboration',
): RawBuilder<boolean> {
  if (authority?.kind === 'agent') {
    return sql<boolean>`
      shareables.workspace_id = ${authority.workspaceId}
      AND shareables.container_id = ${authority.projectId}
      AND shareables.visibility IN ('workspace', 'project')
      AND EXISTS (
        SELECT 1 FROM artifact_containers writable_project
        WHERE writable_project.id = shareables.container_id
          AND writable_project.workspace_id = ${authority.workspaceId}
          AND writable_project.kind = 'project'
          AND writable_project.archived_at IS NULL
          AND (
            writable_project.base_visibility = 'workspace'
            OR EXISTS (
              SELECT 1 FROM project_share_defaults writable_agent_grant
              WHERE writable_agent_grant.project_container_id = writable_project.id
                AND lower(writable_agent_grant.email) = ${user.email?.toLowerCase() ?? ''}
                AND writable_agent_grant.role IN ('contributor', 'manager')
            )
          )
      )`
  }
  if (authority?.kind === 'bridge') return sql<boolean>`0 = 1`
  const verifiedEmail = user.emailVerified
    ? (user.email?.toLowerCase() ?? '')
    : ''
  const externalGrant =
    access === 'version'
      ? sql<boolean>`
      OR (
        shareables.workspace_id != ${user.workspaceId}
        AND ${verifiedEmail} <> ''
        AND EXISTS (
          SELECT 1 FROM users writable_external_user
          WHERE writable_external_user.id = ${user.id}
            AND writable_external_user.kind = 'human'
            AND writable_external_user.email_verified = 1
            AND lower(writable_external_user.email) = ${verifiedEmail}
        )
        AND EXISTS (
          SELECT 1 FROM shareable_grants writable_external_grant
          WHERE writable_external_grant.shareable_id = shareables.id
            AND lower(writable_external_grant.granted_email) = ${verifiedEmail}
        )
        AND EXISTS (
          SELECT 1 FROM workspaces writable_external_workspace
          WHERE writable_external_workspace.id = shareables.workspace_id
            AND writable_external_workspace.plan != 'free'
            AND writable_external_workspace.external_posting_enabled = 1
        )
      )`
      : sql<boolean>``
  return sql<boolean>`
    (shareables.owner_user_id = ${user.id}
    OR (
      shareables.workspace_id = ${user.workspaceId}
      AND EXISTS (
        SELECT 1 FROM workspace_members writable_member
        JOIN users writable_user ON writable_user.id = writable_member.user_id
        WHERE writable_member.workspace_id = shareables.workspace_id
          AND writable_member.user_id = ${user.id}
          AND writable_member.status = 'active'
          AND writable_user.kind = 'human'
      )
      AND (
        (
          shareables.visibility = 'workspace'
          AND NOT EXISTS (
            SELECT 1 FROM artifact_containers archived_project
            WHERE archived_project.id = shareables.container_id
              AND archived_project.kind = 'project'
              AND archived_project.archived_at IS NOT NULL
          )
        )
        OR (
          shareables.visibility = 'project'
          AND EXISTS (
            SELECT 1 FROM artifact_containers writable_project
            WHERE writable_project.id = shareables.container_id
              AND writable_project.kind = 'project'
              AND writable_project.archived_at IS NULL
              AND (
                writable_project.base_visibility = 'workspace'
                OR writable_project.created_by_id = ${user.id}
                OR EXISTS (
                  SELECT 1 FROM workspace_members writable_admin
                  JOIN workspaces writable_workspace ON writable_workspace.id = writable_admin.workspace_id
                  WHERE writable_admin.workspace_id = shareables.workspace_id
                    AND writable_admin.user_id = ${user.id}
                    AND writable_admin.role IN ('owner', 'admin')
                    AND writable_admin.status = 'active'
                    AND writable_workspace.plan = 'team'
                )
                OR EXISTS (
                  SELECT 1 FROM project_share_defaults writable_grant
                  WHERE writable_grant.project_container_id = writable_project.id
                    AND lower(writable_grant.email) = ${verifiedEmail}
                    AND ${verifiedEmail} <> ''
                )
              )
          )
        )
      )
    )${externalGrant})`
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
  const uploader = await db
    .selectFrom('users')
    .select('kind')
    .where('id', '=', userId)
    .executeTakeFirst()
  if (uploader?.kind === 'bot') return 'ok'
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
  if (Number(result.numAffectedRows ?? 0n) === 1) return 'ok'
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

function finalizeContributorSlotQuery(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
): Compilable<unknown> {
  return db
    .updateTable('workspace_members')
    .set({
      pending_uploads: sql<number>`MAX(pending_uploads - 1, 0)`,
      first_contributed_at: sql<string>`COALESCE(first_contributed_at, ${now})`,
      last_contributed_at: now,
      updated_at: now,
    })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM users WHERE users.id = ${userId} AND users.kind = 'human')`,
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

function insertGrantEmailQueries(
  db: Kysely<DB>,
  shareableId: string,
  emails: ReadonlyArray<string>,
  grantedBy: string,
  grantedAt: string,
  opts: { ignoreDuplicates?: boolean } = {},
): Compilable<unknown>[] {
  return chunkArray(emails, 25).map((chunk) => {
    const query = db.insertInto('shareable_grants').values(
      chunk.map((email) => ({
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
  })
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

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
