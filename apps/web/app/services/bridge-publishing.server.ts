import { sql, type Compilable, type Kysely } from 'kysely'
import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { projectLimitForPlan } from '~/lib/billing-plan.server'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { lowerEmail } from '~/lib/grant-emails.server'
import { computeFileSha256, computeTextSha256 } from '~/lib/sha256'
import { createShareableId } from '~/lib/shareable-id'
import { extractTitleFromBytes } from '~/lib/extract-title'
import { STATIC_SITE_UPLOAD_LIMITS } from '~/lib/product-contracts'
import type { DB } from '~/types/db'
import {
  artifactCreatedEventQuery,
  versionPublishedEventQuery,
} from './events.server'
import { fetchArtifactSourceBytes } from './content.server'
import type { CliAuthority } from './cli-authority.server'
import { readLiveBridgeAuthority } from './bridge-authorities.server'
import {
  activeProjectCountAtLimit,
  bindTrustedBridgeRequest,
  conversationProjectName,
  deleteEmptyProject,
  resolveConversation,
  type BindBridgeRequestResult,
  type BoundBridgeRequest,
} from './bridge-conversation-binding.server'
import {
  parseBridgeIntent,
  parseTrustedBridgeContext,
  type BridgeIntent,
  type TrustedBridgeContext,
} from './bridge-request-validation.server'
import {
  prepareUpload,
  normalizeBundlePath,
  notifyArtifactVersionChanged,
  releaseQuota,
  reserveQuota,
  staticSiteEntrypointKind,
  staticSiteMimeType,
  staticSiteR2Prefix,
} from './shareables.server'
import {
  deleteArtifact,
  deleteArtifactsByPrefix,
  putArtifact,
} from './storage.server'
import { validateBundlePath } from '../../workers/lib/path-validator'

const PROJECT_NAME_ATTEMPTS = 3
const REQUEST_LEASE_MS = 60_000
const VERSION_FILE_INSERT_CHUNK_SIZE = 8

type BridgeAuthority = Extract<CliAuthority, { kind: 'bridge' }>
export interface BridgeRequestSuccess {
  artifact: { id: string; url: string; title: string }
  project: { id: string; name: string }
  visibility: 'private' | 'workspace'
  versionId: string | null
  replayed: boolean
  mappingCreated: boolean
  projectCreated: boolean
}

export type ExecuteBridgeRequestResult =
  | { kind: 'ok'; result: BridgeRequestSuccess }
  | {
      kind:
        | Exclude<BindBridgeRequestResult['kind'], 'ok'>
        | 'invalid-context'
        | 'stale-context'
        | 'idempotency-in-progress'
        | 'idempotency-mismatch'
        | 'payload-too-large'
        | 'upload-failed'
        | 'forbidden-target'
        | 'artifact-viewer-limit-reached'
    }

type BridgeUser = {
  id: string
  email?: string | null
  emailVerified: boolean
  workspaceId: string
  hd: string | null
  msTenantId?: string | null
}

export async function executeBridgeRequest(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  user: BridgeUser,
  metadata: unknown,
  files: readonly File[],
  origin: string,
  now = new Date(),
): Promise<ExecuteBridgeRequestResult> {
  const contextResult = parseTrustedBridgeContext(metadata, authority, now)
  if (contextResult.kind !== 'ok') return contextResult

  const bound = await bindTrustedBridgeRequest(
    db,
    authority,
    contextResult.context,
  )
  if (bound.kind !== 'ok') return bound
  if (
    user.id !== bound.binding.authority.botUserId ||
    user.workspaceId !== bound.binding.authority.workspaceId
  ) {
    return { kind: 'unsupported-authority' }
  }

  const intentResult = parseBridgeIntent(metadata)
  if (intentResult.kind !== 'ok') return intentResult
  const ownedFiles = await verifyMultipartFiles(intentResult.intent, files)
  if (ownedFiles.kind !== 'ok') return ownedFiles
  const digest = await computeTextSha256(
    JSON.stringify({
      operation: intentResult.intent.operation,
      requestedAudience: intentResult.intent.requestedAudience,
      targetArtifactId: intentResult.intent.targetArtifactId,
      title: intentResult.intent.title,
      contentKind: intentResult.intent.contentKind,
      files: intentResult.intent.files,
    }),
  )
  const lease = await acquireRequestLease(
    db,
    authority.bridgeAuthorityId,
    contextResult.context.requestId,
    digest,
    now,
  )
  if (lease.kind === 'completed') {
    const replay = await readBridgeResult(
      db,
      authority.bridgeAuthorityId,
      contextResult.context.requestId,
      contextResult.context.requester.verifiedEmail,
      origin,
      true,
    )
    return replay ?? { kind: 'upload-failed' }
  }
  if (lease.kind !== 'acquired') return lease

  let execution: ExecuteBridgeRequestResult
  if (intentResult.intent.operation === 'set_visibility') {
    execution = await setBridgeVisibility(
      db,
      authority,
      contextResult.context,
      intentResult.intent,
      bound.binding,
      lease.generation,
      origin,
    )
  } else if (intentResult.intent.contentKind === 'static_site') {
    execution =
      intentResult.intent.operation === 'publish' ||
      intentResult.intent.operation === 'update'
        ? await publishBridgeStaticSite(
            db,
            authority,
            contextResult.context,
            intentResult.intent,
            bound.binding,
            lease.generation,
            ownedFiles.files,
            origin,
          )
        : { kind: 'forbidden-target' }
  } else if (
    intentResult.intent.contentKind !== 'file' ||
    ownedFiles.files.length !== 1
  ) {
    execution = { kind: 'forbidden-target' }
  } else if (intentResult.intent.operation === 'publish') {
    execution = await publishBridgeFile(
      db,
      authority,
      user,
      contextResult.context,
      intentResult.intent,
      bound.binding,
      lease.generation,
      ownedFiles.files[0]!,
      origin,
    )
  } else {
    execution = await publishBridgeFileVersion(
      db,
      authority,
      contextResult.context,
      intentResult.intent,
      bound.binding,
      lease.generation,
      ownedFiles.files[0]!,
      origin,
    )
  }
  if (execution.kind !== 'ok') {
    await releaseRequestLease(
      db,
      authority.bridgeAuthorityId,
      contextResult.context.requestId,
      lease.generation,
    )
  }
  return execution
}
async function verifyMultipartFiles(
  intent: BridgeIntent,
  files: readonly File[],
): Promise<
  | { kind: 'ok'; files: File[] }
  | { kind: 'invalid-context' | 'payload-too-large' }
> {
  if (files.length !== intent.files.length) return { kind: 'invalid-context' }
  const owned: File[] = []
  let total = 0
  for (const [index, descriptor] of intent.files.entries()) {
    const file = files[index]
    if (
      !file ||
      file.size !== descriptor.size ||
      file.type !== descriptor.mediaType
    ) {
      return { kind: 'invalid-context' }
    }
    total += file.size
    if (total > 26_214_400) return { kind: 'payload-too-large' }
    if ((await fileSha256Hex(file)) !== descriptor.sha256) {
      return { kind: 'invalid-context' }
    }
    owned.push(
      new File([await file.arrayBuffer()], descriptor.path, {
        type: descriptor.mediaType,
      }),
    )
  }
  return { kind: 'ok', files: owned }
}

type PreparedBridgeFile = Extract<
  Awaited<ReturnType<typeof prepareUpload>>,
  { kind: 'ok' }
>

type PreparedBridgeArtifact = Pick<
  PreparedBridgeFile,
  | 'versionId'
  | 'now'
  | 'sha256'
  | 'sizeBytes'
  | 'entrypointPath'
  | 'r2Key'
  | 'derivedTitle'
> & {
  artifactKind: 'html_page' | 'markdown_page' | 'static_site'
  fallbackToIndex?: number
  versionFiles?: Array<{
    id: string
    version_id: string
    path: string
    r2_key: string
    mime_type: string
    size_bytes: number
    sha256: string
    scan_flags: string | null
    created_at: string
  }>
}

type BridgeTarget = {
  id: string
  name: string
  artifactKind: string
  visibility: 'private' | 'workspace' | 'project' | 'link'
  currentVersionId: string
  currentR2Key: string
  projectId: string
  projectName: string
}

async function resolveBridgeTarget(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  binding: BoundBridgeRequest,
  artifactId: string,
): Promise<BridgeTarget | null> {
  let query = db
    .selectFrom('shareables as artifact')
    .innerJoin(
      'versions as version',
      'version.id',
      'artifact.current_version_id',
    )
    .innerJoin(
      'artifact_containers as project',
      'project.id',
      'artifact.container_id',
    )
    .select([
      'artifact.id',
      'artifact.name',
      'artifact.artifact_kind',
      'artifact.visibility',
      'artifact.current_version_id',
      'version.r2_key',
      'project.id as project_id',
      'project.name as project_name',
    ])
    .where('artifact.id', '=', artifactId)
    .where('artifact.workspace_id', '=', authority.workspaceId)
    .where(
      'artifact.created_by_agent_profile_id',
      '=',
      authority.agentProfileId,
    )
    .where('project.archived_at', 'is', null)
    .where(
      sql<boolean>`EXISTS (
        SELECT 1 FROM bridge_operations operation
        WHERE operation.artifact_id = artifact.id
          AND operation.bridge_authority_id = ${authority.bridgeAuthorityId}
      )`,
    )
  if (binding.routingClass === 'channel') {
    if (!binding.mapping) return null
    query = query.where('artifact.container_id', '=', binding.mapping.projectId)
  } else {
    query = query
      .where('artifact.container_id', '=', binding.authority.fallbackProjectId)
      .where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM bridge_dm_artifacts dm
          WHERE dm.artifact_id = artifact.id
            AND dm.bridge_authority_id = ${authority.bridgeAuthorityId}
            AND dm.requester_stable_id = ${context.requester.stableId}
        )`,
      )
  }
  const row = await query.executeTakeFirst()
  if (!row?.current_version_id) return null
  return {
    id: row.id,
    name: row.name,
    artifactKind: row.artifact_kind,
    visibility: row.visibility,
    currentVersionId: row.current_version_id,
    currentR2Key: row.r2_key,
    projectId: row.project_id,
    projectName: row.project_name,
  }
}

async function publishBridgeFileVersion(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  intent: BridgeIntent,
  binding: BoundBridgeRequest,
  leaseGeneration: string,
  requestFile: File,
  origin: string,
): Promise<ExecuteBridgeRequestResult> {
  if (!intent.targetArtifactId) return { kind: 'forbidden-target' }
  const target = await resolveBridgeTarget(
    db,
    authority,
    context,
    binding,
    intent.targetArtifactId,
  )
  if (!target) return { kind: 'forbidden-target' }
  let file = requestFile
  if (intent.operation === 'append') {
    if (
      target.artifactKind !== 'markdown_page' &&
      target.artifactKind !== 'html_page'
    ) {
      return { kind: 'forbidden-target' }
    }
    const appended = await appendBridgeFile(target, requestFile)
    if (!appended) return { kind: 'upload-failed' }
    file = appended
  }
  const prepared = await prepareUpload(
    db,
    authority.workspaceId,
    target.id,
    file,
  )
  if (prepared.kind !== 'ok') {
    return prepared.kind === 'too-large'
      ? { kind: 'payload-too-large' }
      : { kind: 'invalid-context' }
  }
  const reserved = await reserveQuota(
    db,
    authority.workspaceId,
    prepared.sizeBytes,
    prepared.now,
  )
  if (reserved !== 'ok') return { kind: 'upload-failed' }
  try {
    await putArtifact(env.BUCKET, prepared.r2Key, prepared.body, {
      contentType: prepared.contentType,
    })
  } catch {
    await releaseQuota(
      db,
      authority.workspaceId,
      prepared.sizeBytes,
      prepared.now,
    )
    return { kind: 'upload-failed' }
  }

  const final = await resolveFinalDestination(db, authority, context, binding)
  let failure: ExecuteBridgeRequestResult = { kind: 'upload-failed' }
  if (final.kind !== 'ok') {
    failure = final
  } else if (
    context.conversation.kind === 'public_channel' &&
    !publicContextFresh(context, new Date())
  ) {
    failure = { kind: 'stale-context' }
  } else {
    const committed = await commitBridgeVersion(db, {
      authority,
      context,
      intent,
      binding: final.binding,
      target,
      leaseGeneration,
      prepared,
    })
    if (committed) {
      await notifyArtifactVersionChanged(target.id, prepared.versionId)
      const result = await readBridgeResult(
        db,
        authority.bridgeAuthorityId,
        context.requestId,
        context.requester.verifiedEmail,
        origin,
        false,
      )
      if (result) return result
      return (await bridgeGrantLimitReached(
        db,
        target.id,
        context.requester.verifiedEmail,
      ))
        ? { kind: 'artifact-viewer-limit-reached' }
        : { kind: 'upload-failed' }
    }
    if (
      await bridgeGrantLimitReached(
        db,
        target.id,
        context.requester.verifiedEmail,
      )
    ) {
      failure = { kind: 'artifact-viewer-limit-reached' }
    }
  }
  const replay = await readBridgeResult(
    db,
    authority.bridgeAuthorityId,
    context.requestId,
    context.requester.verifiedEmail,
    origin,
    true,
  )
  await Promise.all([
    deleteArtifact(env.BUCKET, prepared.r2Key).catch(() => undefined),
    releaseQuota(db, authority.workspaceId, prepared.sizeBytes, prepared.now),
  ])
  if (replay) return replay
  return failure
}

async function publishBridgeStaticSite(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  intent: BridgeIntent,
  binding: BoundBridgeRequest,
  leaseGeneration: string,
  files: readonly File[],
  origin: string,
): Promise<ExecuteBridgeRequestResult> {
  let target: BridgeTarget | null = null
  let shareableId: string
  if (intent.operation === 'update') {
    if (!intent.targetArtifactId) return { kind: 'forbidden-target' }
    target = await resolveBridgeTarget(
      db,
      authority,
      context,
      binding,
      intent.targetArtifactId,
    )
    if (!target || target.artifactKind !== 'static_site') {
      return { kind: 'forbidden-target' }
    }
    shareableId = target.id
  } else {
    shareableId = createShareableId()
    if (
      await db
        .selectFrom('shareables')
        .select('id')
        .where('id', '=', shareableId)
        .executeTakeFirst()
    ) {
      return { kind: 'upload-failed' }
    }
  }
  const staged = await stageBridgeStaticSite(
    db,
    authority.workspaceId,
    shareableId,
    files,
  )
  if (staged.kind !== 'ok') return staged

  const final = await resolveFinalDestination(db, authority, context, binding)
  let failure: ExecuteBridgeRequestResult = { kind: 'upload-failed' }
  if (final.kind !== 'ok') {
    failure = final
  } else if (
    context.conversation.kind === 'public_channel' &&
    !publicContextFresh(context, new Date())
  ) {
    failure = { kind: 'stale-context' }
  } else if (target) {
    const committed = await commitBridgeVersion(db, {
      authority,
      context,
      intent,
      binding: final.binding,
      target,
      leaseGeneration,
      prepared: staged.prepared,
    })
    if (committed) {
      await notifyArtifactVersionChanged(target.id, staged.prepared.versionId)
      const result = await readBridgeResult(
        db,
        authority.bridgeAuthorityId,
        context.requestId,
        context.requester.verifiedEmail,
        origin,
        false,
      )
      if (result) return result
      return (await bridgeGrantLimitReached(
        db,
        target.id,
        context.requester.verifiedEmail,
      ))
        ? { kind: 'artifact-viewer-limit-reached' }
        : { kind: 'upload-failed' }
    }
    if (
      await bridgeGrantLimitReached(
        db,
        target.id,
        context.requester.verifiedEmail,
      )
    ) {
      failure = { kind: 'artifact-viewer-limit-reached' }
    }
  } else {
    let currentBinding = final.binding
    for (let attempt = 0; attempt < PROJECT_NAME_ATTEMPTS; attempt += 1) {
      const committed = await commitBridgePublish(db, {
        authority,
        context,
        intent,
        binding: currentBinding,
        leaseGeneration,
        prepared: staged.prepared,
        shareableId,
      })
      if (committed.kind === 'ok') {
        await notifyArtifactVersionChanged(
          shareableId,
          staged.prepared.versionId,
        )
        const result = await readBridgeResult(
          db,
          authority.bridgeAuthorityId,
          context.requestId,
          context.requester.verifiedEmail,
          origin,
          false,
        )
        if (result) return result
        return { kind: 'upload-failed' }
      }
      failure = committed
      if (committed.kind === 'project-name-conflict') continue
      if (committed.kind !== 'conversation-identity-conflict') break
      const resolved = await resolveConversation(
        db,
        authority.bridgeAuthorityId,
        context.conversation.ids,
      )
      if (resolved.kind !== 'ok' || !resolved.mapping) break
      currentBinding = {
        ...currentBinding,
        mapping: resolved.mapping,
        mappingCreated: false,
        projectCreated: false,
      }
    }
  }
  const replay = await readBridgeResult(
    db,
    authority.bridgeAuthorityId,
    context.requestId,
    context.requester.verifiedEmail,
    origin,
    true,
  )
  await Promise.all([
    deleteArtifactsByPrefix(env.BUCKET, staged.prefix).catch(() => undefined),
    releaseQuota(
      db,
      authority.workspaceId,
      staged.prepared.sizeBytes,
      staged.prepared.now,
    ),
  ])
  if (replay) return replay
  return failure
}

async function stageBridgeStaticSite(
  db: Kysely<DB>,
  workspaceId: string,
  shareableId: string,
  files: readonly File[],
): Promise<
  | {
      kind: 'ok'
      prefix: string
      prepared: PreparedBridgeArtifact
    }
  | { kind: 'invalid-context' | 'payload-too-large' | 'upload-failed' }
> {
  if (files.length === 0 || files.length > STATIC_SITE_UPLOAD_LIMITS.files) {
    return { kind: 'invalid-context' }
  }
  const versionId = nanoid(16)
  const now = nowIso()
  const prefix = staticSiteR2Prefix(workspaceId, shareableId, versionId)
  const seen = new Set<string>()
  const validated: Array<{
    file: File
    path: string
    r2Key: string
    mimeType: string
    entrypointKind: 'html' | 'md' | null
  }> = []
  let total = 0
  for (const file of files) {
    if (file.size > STATIC_SITE_UPLOAD_LIMITS.fileBytes) {
      return { kind: 'payload-too-large' }
    }
    total += file.size
    if (total > STATIC_SITE_UPLOAD_LIMITS.totalBytes) {
      return { kind: 'payload-too-large' }
    }
    const validation = validateBundlePath(file.name)
    if (validation.kind === 'blocked') return { kind: 'invalid-context' }
    const path = normalizeBundlePath(file.name)
    const key = path.toLowerCase()
    const depth = Math.max(path.split('/').filter(Boolean).length - 1, 0)
    if (
      path.length > STATIC_SITE_UPLOAD_LIMITS.pathChars ||
      depth > STATIC_SITE_UPLOAD_LIMITS.folderDepth ||
      seen.has(key)
    ) {
      return { kind: 'invalid-context' }
    }
    const mimeType = staticSiteMimeType(path)
    if (!mimeType) return { kind: 'invalid-context' }
    const r2Key = `${prefix}${path.slice(1)}`
    validated.push({
      file,
      path,
      r2Key,
      mimeType,
      entrypointKind: staticSiteEntrypointKind(path),
    })
    seen.add(key)
  }
  const stagedWithBodies = await Promise.all(
    validated.map(async ({ file, path, r2Key, mimeType, entrypointKind }) => {
      const body = await file.arrayBuffer()
      return {
        body,
        entrypointKind,
        row: {
          id: nanoid(16),
          version_id: versionId,
          path,
          r2_key: r2Key,
          mime_type: mimeType,
          size_bytes: file.size,
          sha256: await computeFileSha256(body),
          scan_flags: null,
          created_at: now,
        },
      }
    }),
  )
  const staged = stagedWithBodies.map(({ row }) => row)
  const entrypointFile =
    stagedWithBodies.find(
      ({ row }) => row.path.toLowerCase() === '/index.html',
    ) ?? stagedWithBodies.find(({ entrypointKind }) => entrypointKind !== null)
  const entrypoint =
    entrypointFile?.entrypointKind === null || entrypointFile === undefined
      ? null
      : {
          path: entrypointFile.row.path,
          r2Key: entrypointFile.row.r2_key,
          body: entrypointFile.body,
          kind: entrypointFile.entrypointKind,
        }
  if (!entrypoint) return { kind: 'invalid-context' }
  const reserved = await reserveQuota(db, workspaceId, total, now)
  if (reserved !== 'ok') return { kind: 'upload-failed' }
  try {
    await Promise.all(
      stagedWithBodies.map(({ body, row }) =>
        putArtifact(env.BUCKET, row.r2_key, body, {
          contentType: row.mime_type,
        }),
      ),
    )
  } catch {
    await Promise.all([
      deleteArtifactsByPrefix(env.BUCKET, prefix).catch(() => undefined),
      releaseQuota(db, workspaceId, total, now),
    ])
    return { kind: 'upload-failed' }
  }
  const bundleSha = await computeFileSha256(
    new TextEncoder().encode(
      staged
        .map((row) => `${row.path}\0${row.size_bytes}\0${row.sha256}`)
        .sort()
        .join('\n'),
    ).buffer,
  )
  return {
    kind: 'ok',
    prefix,
    prepared: {
      versionId,
      now,
      sha256: bundleSha,
      sizeBytes: total,
      artifactKind: 'static_site',
      entrypointPath: entrypoint.path,
      r2Key: entrypoint.r2Key,
      derivedTitle: extractTitleFromBytes(entrypoint.body, entrypoint.kind, {
        shareableId,
        fileName: entrypoint.path,
      }),
      fallbackToIndex: entrypoint.kind === 'html' ? 1 : 0,
      versionFiles: staged,
    },
  }
}

async function appendBridgeFile(
  target: BridgeTarget,
  addition: File,
): Promise<File | null> {
  const source = await fetchArtifactSourceBytes(target.currentR2Key)
  if (source.kind !== 'ok') return null
  let additionText: string
  try {
    additionText = new TextDecoder('utf-8', { fatal: true }).decode(
      await addition.arrayBuffer(),
    )
  } catch {
    return null
  }
  const sourceBytes = new Uint8Array(source.body)
  let insertAt = sourceBytes.byteLength
  if (target.artifactKind === 'html_page') {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
    } catch {
      return null
    }
    const match = /<\/body\s*>/giu
    let found: RegExpExecArray | null
    while ((found = match.exec(text)) !== null) {
      insertAt = new TextEncoder().encode(text.slice(0, found.index)).byteLength
    }
  }
  return new File(
    [source.body.slice(0, insertAt), additionText, source.body.slice(insertAt)],
    target.name,
    {
      type:
        target.artifactKind === 'markdown_page' ? 'text/markdown' : 'text/html',
    },
  )
}

async function commitBridgeVersion(
  db: Kysely<DB>,
  input: {
    authority: BridgeAuthority
    context: TrustedBridgeContext
    intent: BridgeIntent
    binding: BoundBridgeRequest
    target: BridgeTarget
    leaseGeneration: string
    prepared: PreparedBridgeArtifact
  },
): Promise<boolean> {
  const operationId = nanoid()
  const versionInsert = guardedVersionInsert(db, input)
  const scope = bridgeTargetScopeSql(input)
  const visibility = bridgeTargetVisibilitySql(input)
  const update = db
    .updateTable('shareables')
    .set({
      artifact_kind: input.prepared.artifactKind,
      derived_title: input.prepared.derivedTitle,
      ...(input.intent.title ? { title_override: input.intent.title } : {}),
      visibility,
      link_expires_at: null,
      current_version_id: input.prepared.versionId,
      updated_at: input.prepared.now,
    })
    .where('id', '=', input.target.id)
    .where('current_version_id', '=', input.target.currentVersionId)
    .where(scope)
    .where(
      bridgeGrantAvailableSql(
        input.target.id,
        input.context.requester.verifiedEmail,
      ),
    )
  const queries: Compilable<unknown>[] = [versionInsert]
  if (input.prepared.versionFiles?.length) {
    queries.push(
      ...chunkArray(
        input.prepared.versionFiles,
        VERSION_FILE_INSERT_CHUNK_SIZE,
      ).map((rows) => db.insertInto('version_files').values(rows)),
    )
  }
  queries.push(
    update,
    bridgeGrantQuery(db, {
      artifactId: input.target.id,
      email: input.context.requester.verifiedEmail,
      grantedAt: input.prepared.now,
      grantedBy: input.binding.authority.botUserId,
    }),
    db.insertInto('bridge_operations').values({
      id: operationId,
      bridge_authority_id: input.authority.bridgeAuthorityId,
      request_id: input.context.requestId,
      lease_generation: input.leaseGeneration,
      operation: input.intent.operation,
      requester_stable_id: input.context.requester.stableId,
      requester_verified_email: input.context.requester.verifiedEmail,
      requester_display_name: input.context.requester.displayName,
      artifact_id: input.target.id,
      version_id: input.prepared.versionId,
      created_at: input.prepared.now,
    }),
    versionPublishedEventQuery(db, { versionId: input.prepared.versionId }),
    db
      .updateTable('bridge_requests')
      .set({
        status: 'completed',
        result_artifact_id: input.target.id,
        result_version_id: input.prepared.versionId,
        updated_at: input.prepared.now,
      })
      .where('bridge_authority_id', '=', input.authority.bridgeAuthorityId)
      .where('request_id', '=', input.context.requestId)
      .where('status', '=', 'leased')
      .where('lease_generation', '=', input.leaseGeneration),
  )
  try {
    await runD1Batch(db, ...queries)
  } catch (error) {
    console.error('bridge_version_commit_failed', {
      request_id: input.context.requestId,
      artifact_id: input.target.id,
      error,
    })
    return false
  }
  const committed = await db
    .selectFrom('versions')
    .select('id')
    .where('id', '=', input.prepared.versionId)
    .executeTakeFirst()
  return Boolean(committed)
}

function guardedVersionInsert(
  db: Kysely<DB>,
  input: {
    authority: BridgeAuthority
    context: TrustedBridgeContext
    binding: BoundBridgeRequest
    target: BridgeTarget
    leaseGeneration: string
    prepared: PreparedBridgeArtifact
  },
) {
  return db
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
        .selectFrom('shareables as artifact')
        .innerJoin('bridge_requests as request', (join) =>
          join
            .on(
              'request.bridge_authority_id',
              '=',
              input.authority.bridgeAuthorityId,
            )
            .on('request.request_id', '=', input.context.requestId),
        )
        .select([
          eb.val(input.prepared.versionId).as('id'),
          eb.val(input.target.id).as('shareable_id'),
          eb.val(input.prepared.artifactKind).as('artifact_kind'),
          eb.val('published').as('status'),
          eb.val(input.prepared.entrypointPath).as('entrypoint_path'),
          eb.val(input.prepared.r2Key).as('r2_key'),
          eb.val(input.prepared.sizeBytes).as('size_bytes'),
          eb.val(input.prepared.sha256).as('sha256'),
          eb.val(input.prepared.fallbackToIndex ?? 0).as('fallback_to_index'),
          eb.val(input.binding.authority.botUserId).as('created_by_id'),
          eb.val(input.prepared.now).as('created_at'),
          eb.val(input.prepared.now).as('published_at'),
        ])
        .where('artifact.id', '=', input.target.id)
        .where(
          'artifact.current_version_id',
          '=',
          input.target.currentVersionId,
        )
        .where('request.status', '=', 'leased')
        .where('request.lease_generation', '=', input.leaseGeneration)
        .where(
          bridgeGrantAvailableSql(
            input.target.id,
            input.context.requester.verifiedEmail,
          ),
        )
        .where(bridgeTargetScopeSql(input, 'artifact')),
    )
}

function bridgeTargetScopeSql(
  input: {
    authority: BridgeAuthority
    context: TrustedBridgeContext
    binding: BoundBridgeRequest
    target: BridgeTarget
  },
  artifactAlias = 'shareables',
) {
  const artifact = sql.ref(artifactAlias)
  if (input.binding.routingClass === 'dm') {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM bridge_authorities bridge
      JOIN users bot ON bot.id = bridge.bot_user_id
      JOIN artifact_containers fallback ON fallback.id = bridge.fallback_project_id
      JOIN bridge_dm_artifacts dm ON dm.bridge_authority_id = bridge.id
      WHERE bridge.id = ${input.authority.bridgeAuthorityId}
        AND bot.bot_stopped_at IS NULL
        AND fallback.id = ${input.binding.authority.fallbackProjectId}
        AND fallback.workspace_id = ${input.authority.workspaceId}
        AND fallback.kind = 'project'
        AND fallback.archived_at IS NULL
        AND dm.artifact_id = ${artifact}.id
        AND dm.requester_stable_id = ${input.context.requester.stableId}
        AND ${artifact}.container_id = fallback.id
        AND ${artifact}.created_by_agent_profile_id = ${input.authority.agentProfileId}
    )`
  }
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM bridge_conversations mapping
    JOIN artifact_containers project ON project.id = mapping.project_id
    WHERE mapping.id = ${input.binding.mapping?.id ?? ''}
      AND mapping.bridge_authority_id = ${input.authority.bridgeAuthorityId}
      AND project.workspace_id = ${input.authority.workspaceId}
      AND project.kind = 'project'
      AND project.archived_at IS NULL
      AND ${artifact}.container_id = project.id
      AND ${artifact}.created_by_agent_profile_id = ${input.authority.agentProfileId}
      AND EXISTS (
        SELECT 1 FROM bridge_operations provenance
        WHERE provenance.artifact_id = ${artifact}.id
          AND provenance.bridge_authority_id = ${input.authority.bridgeAuthorityId}
      )
  )`
}

function bridgeTargetVisibilitySql(input: {
  authority: BridgeAuthority
  intent: BridgeIntent
  binding: BoundBridgeRequest
}) {
  if (input.binding.routingClass === 'dm') {
    return sql<'private' | 'workspace'>`CASE
      WHEN ${input.intent.requestedAudience} = 'workspace'
        AND shareables.visibility = 'workspace'
        AND EXISTS (
          SELECT 1 FROM artifact_containers fallback
          WHERE fallback.id = ${input.binding.authority.fallbackProjectId}
            AND fallback.workspace_id = ${input.authority.workspaceId}
            AND fallback.kind = 'project'
            AND fallback.archived_at IS NULL
            AND fallback.base_visibility = 'workspace'
        )
      THEN 'workspace'
      ELSE 'private'
    END`
  }
  return sql<'private' | 'project'>`CASE
    WHEN ${input.intent.requestedAudience} = 'private'
      OR EXISTS (
        SELECT 1
        FROM bridge_conversations mapping
        JOIN artifact_containers project ON project.id = mapping.project_id
        WHERE mapping.id = ${input.binding.mapping?.id ?? ''}
          AND (
            mapping.privacy_ceiling = 'private'
            OR project.base_visibility = 'private'
          )
      )
    THEN 'private'
    ELSE 'project'
  END`
}

async function setBridgeVisibility(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  intent: BridgeIntent,
  binding: BoundBridgeRequest,
  leaseGeneration: string,
  origin: string,
): Promise<ExecuteBridgeRequestResult> {
  if (!intent.targetArtifactId) return { kind: 'forbidden-target' }
  const target = await resolveBridgeTarget(
    db,
    authority,
    context,
    binding,
    intent.targetArtifactId,
  )
  if (!target) return { kind: 'forbidden-target' }
  const final = await resolveFinalDestination(db, authority, context, binding)
  if (final.kind !== 'ok') return final
  if (
    context.conversation.kind === 'public_channel' &&
    !publicContextFresh(context, new Date())
  ) {
    return { kind: 'stale-context' }
  }
  const operationId = nanoid()
  const now = nowIso()
  const scope = bridgeTargetScopeSql(
    { authority, context, binding: final.binding, target },
    'shareables',
  )
  const visibility =
    final.binding.routingClass === 'dm' &&
    intent.requestedAudience === 'workspace'
      ? sql<'private' | 'workspace'>`CASE WHEN EXISTS (
          SELECT 1 FROM artifact_containers fallback
          WHERE fallback.id = ${final.binding.authority.fallbackProjectId}
            AND fallback.workspace_id = ${authority.workspaceId}
            AND fallback.kind = 'project'
            AND fallback.archived_at IS NULL
            AND fallback.base_visibility = 'workspace'
        ) THEN 'workspace' ELSE 'private' END`
      : bridgeTargetVisibilitySql({ authority, intent, binding: final.binding })
  const operationInsert = db
    .insertInto('bridge_operations')
    .columns([
      'id',
      'bridge_authority_id',
      'request_id',
      'lease_generation',
      'operation',
      'requester_stable_id',
      'requester_verified_email',
      'requester_display_name',
      'artifact_id',
      'version_id',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('shareables as artifact')
        .innerJoin('bridge_requests as request', (join) =>
          join
            .on('request.bridge_authority_id', '=', authority.bridgeAuthorityId)
            .on('request.request_id', '=', context.requestId),
        )
        .select([
          eb.val(operationId).as('id'),
          eb.val(authority.bridgeAuthorityId).as('bridge_authority_id'),
          eb.val(context.requestId).as('request_id'),
          eb.val(leaseGeneration).as('lease_generation'),
          eb.val('set_visibility' as const).as('operation'),
          eb.val(context.requester.stableId).as('requester_stable_id'),
          eb
            .val(context.requester.verifiedEmail)
            .as('requester_verified_email'),
          eb.val(context.requester.displayName).as('requester_display_name'),
          eb.val(target.id).as('artifact_id'),
          eb.val(null).as('version_id'),
          eb.val(now).as('created_at'),
        ])
        .where('artifact.id', '=', target.id)
        .where('request.status', '=', 'leased')
        .where('request.lease_generation', '=', leaseGeneration)
        .where(
          bridgeGrantAvailableSql(target.id, context.requester.verifiedEmail),
        )
        .where(
          bridgeTargetScopeSql(
            { authority, context, binding: final.binding, target },
            'artifact',
          ),
        ),
    )
  try {
    await runD1Batch(
      db,
      db
        .updateTable('shareables')
        .set({ visibility, link_expires_at: null, updated_at: now })
        .where('id', '=', target.id)
        .where(scope)
        .where(
          bridgeGrantAvailableSql(target.id, context.requester.verifiedEmail),
        )
        .where(
          bridgeLeaseActiveSql({
            authorityId: authority.bridgeAuthorityId,
            requestId: context.requestId,
            generation: leaseGeneration,
          }),
        ),
      bridgeGrantQuery(db, {
        artifactId: target.id,
        email: context.requester.verifiedEmail,
        grantedAt: now,
        grantedBy: final.binding.authority.botUserId,
        lease: {
          authorityId: authority.bridgeAuthorityId,
          requestId: context.requestId,
          generation: leaseGeneration,
        },
      }),
      operationInsert,
      db
        .updateTable('bridge_requests')
        .set({
          status: 'completed',
          result_artifact_id: target.id,
          result_version_id: null,
          updated_at: now,
        })
        .where('bridge_authority_id', '=', authority.bridgeAuthorityId)
        .where('request_id', '=', context.requestId)
        .where('status', '=', 'leased')
        .where('lease_generation', '=', leaseGeneration)
        .where(
          sql<boolean>`EXISTS (
            SELECT 1 FROM bridge_operations
            WHERE id = ${operationId}
          )`,
        ),
    )
  } catch (error) {
    console.error('bridge_visibility_commit_failed', {
      request_id: context.requestId,
      artifact_id: target.id,
      error,
    })
    return (await bridgeGrantLimitReached(
      db,
      target.id,
      context.requester.verifiedEmail,
    ))
      ? { kind: 'artifact-viewer-limit-reached' }
      : { kind: 'upload-failed' }
  }
  const result = await readBridgeResult(
    db,
    authority.bridgeAuthorityId,
    context.requestId,
    context.requester.verifiedEmail,
    origin,
    false,
  )
  if (result) return result
  return (await bridgeGrantLimitReached(
    db,
    target.id,
    context.requester.verifiedEmail,
  ))
    ? { kind: 'artifact-viewer-limit-reached' }
    : { kind: 'upload-failed' }
}

async function publishBridgeFile(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  user: BridgeUser,
  context: TrustedBridgeContext,
  intent: BridgeIntent,
  initialBinding: BoundBridgeRequest,
  leaseGeneration: string,
  file: File,
  origin: string,
): Promise<ExecuteBridgeRequestResult> {
  let shareableId = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = createShareableId()
    const exists = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', candidate)
      .executeTakeFirst()
    if (!exists) {
      shareableId = candidate
      break
    }
  }
  if (!shareableId) return { kind: 'upload-failed' }
  const prepared = await prepareUpload(
    db,
    authority.workspaceId,
    shareableId,
    file,
  )
  if (prepared.kind !== 'ok') {
    return prepared.kind === 'too-large'
      ? { kind: 'payload-too-large' }
      : { kind: 'invalid-context' }
  }
  const reserved = await reserveQuota(
    db,
    authority.workspaceId,
    prepared.sizeBytes,
    prepared.now,
  )
  if (reserved !== 'ok') return { kind: 'upload-failed' }
  try {
    await putArtifact(env.BUCKET, prepared.r2Key, prepared.body, {
      contentType: prepared.contentType,
    })
  } catch {
    await releaseQuota(
      db,
      authority.workspaceId,
      prepared.sizeBytes,
      prepared.now,
    )
    return { kind: 'upload-failed' }
  }

  let binding = initialBinding
  let lastFailure: ExecuteBridgeRequestResult = { kind: 'upload-failed' }
  for (let attempt = 0; attempt < PROJECT_NAME_ATTEMPTS; attempt += 1) {
    const final = await resolveFinalDestination(db, authority, context, binding)
    if (final.kind !== 'ok') {
      lastFailure = final
      break
    }
    binding = final.binding
    if (
      context.conversation.kind === 'public_channel' &&
      !publicContextFresh(context, new Date())
    ) {
      lastFailure = { kind: 'stale-context' }
      break
    }
    const committed = await commitBridgePublish(db, {
      authority,
      context,
      intent,
      binding,
      leaseGeneration,
      prepared,
      shareableId,
    })
    if (committed.kind === 'ok') {
      await notifyArtifactVersionChanged(shareableId, prepared.versionId)
      const result = await readBridgeResult(
        db,
        authority.bridgeAuthorityId,
        context.requestId,
        context.requester.verifiedEmail,
        origin,
        false,
      )
      if (result) return result
      return { kind: 'upload-failed' }
    }
    lastFailure = committed
    if (committed.kind === 'project-name-conflict') continue
    if (committed.kind !== 'conversation-identity-conflict') break
    const rebound = await resolveConversation(
      db,
      authority.bridgeAuthorityId,
      context.conversation.ids,
    )
    if (rebound.kind !== 'ok' || rebound.mapping === null) break
    binding = {
      ...binding,
      mapping: rebound.mapping,
      mappingCreated: false,
      projectCreated: false,
    }
  }

  const replay = await readBridgeResult(
    db,
    authority.bridgeAuthorityId,
    context.requestId,
    context.requester.verifiedEmail,
    origin,
    true,
  )
  await Promise.all([
    deleteArtifact(env.BUCKET, prepared.r2Key).catch(() => undefined),
    releaseQuota(db, authority.workspaceId, prepared.sizeBytes, prepared.now),
  ])
  if (replay) return replay
  return lastFailure
}

async function resolveFinalDestination(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  binding: BoundBridgeRequest,
): Promise<
  | { kind: 'ok'; binding: BoundBridgeRequest }
  | {
      kind:
        | 'unsupported-authority'
        | 'fallback-invalid'
        | 'mapping-archived'
        | 'conversation-identity-conflict'
    }
> {
  const live = await readLiveBridgeAuthority(db, authority.bridgeAuthorityId)
  if (live.kind !== 'ok') return { kind: live.kind }
  if (binding.routingClass === 'dm') {
    return { kind: 'ok', binding: { ...binding, authority: live } }
  }
  const resolved = await resolveConversation(
    db,
    authority.bridgeAuthorityId,
    context.conversation.ids,
  )
  if (resolved.kind !== 'ok') return resolved
  if (resolved.mapping?.archived) return { kind: 'mapping-archived' }
  return {
    kind: 'ok',
    binding: { ...binding, authority: live, mapping: resolved.mapping },
  }
}

async function commitBridgePublish(
  db: Kysely<DB>,
  input: {
    authority: BridgeAuthority
    context: TrustedBridgeContext
    intent: BridgeIntent
    binding: BoundBridgeRequest
    leaseGeneration: string
    prepared: PreparedBridgeArtifact
    shareableId: string
  },
): Promise<
  | { kind: 'ok' }
  | {
      kind:
        | 'conversation-identity-conflict'
        | 'project-limit-reached'
        | 'project-name-conflict'
        | 'upload-failed'
    }
> {
  const { authority, context, intent, prepared } = input
  const createMapping =
    input.binding.routingClass === 'channel' && input.binding.mapping === null
  const mappingId = createMapping
    ? nanoid()
    : (input.binding.mapping?.id ?? null)
  const projectId = createMapping
    ? nanoid()
    : (input.binding.mapping?.projectId ??
      input.binding.authority.fallbackProjectId)
  const projectName = createMapping
    ? conversationProjectName(context.conversation.name, projectId)
    : (input.binding.mapping?.projectName ??
      input.binding.authority.fallbackName)
  const operationId = nanoid()
  const queries: Compilable<unknown>[] = []
  if (createMapping) {
    const workspace = await db
      .selectFrom('workspaces')
      .select('plan')
      .where('id', '=', authority.workspaceId)
      .executeTakeFirst()
    if (!workspace) return { kind: 'upload-failed' }
    const limit = projectLimitForPlan(workspace.plan)
    queries.push(
      guardedProjectInsert(
        db,
        authority,
        context,
        projectId,
        projectName,
        prepared.now,
        limit,
      ),
      db.insertInto('bridge_conversations').values({
        id: mappingId!,
        bridge_authority_id: authority.bridgeAuthorityId,
        project_id: projectId,
        conversation_kind: 'public_channel',
        conversation_name: context.conversation.name,
        privacy_ceiling: 'workspace',
        privacy_epoch: 0,
        created_at: prepared.now,
        updated_at: prepared.now,
      }),
      db.insertInto('bridge_conversation_ids').values(
        context.conversation.ids.map((id) => ({
          mapping_id: mappingId!,
          bridge_authority_id: authority.bridgeAuthorityId,
          external_conversation_id: id,
          created_at: prepared.now,
        })),
      ),
    )
  }
  queries.push(
    guardedShareableInsert(db, {
      authority,
      context,
      intent,
      binding: input.binding,
      mappingId,
      projectId,
      shareableId: input.shareableId,
      prepared,
      leaseGeneration: input.leaseGeneration,
    }),
    db.insertInto('versions').values({
      id: prepared.versionId,
      shareable_id: input.shareableId,
      artifact_kind: prepared.artifactKind,
      status: 'published',
      entrypoint_path: prepared.entrypointPath,
      r2_key: prepared.r2Key,
      size_bytes: prepared.sizeBytes,
      sha256: prepared.sha256,
      fallback_to_index: prepared.fallbackToIndex ?? 0,
      created_by_id: input.binding.authority.botUserId,
      created_at: prepared.now,
      published_at: prepared.now,
    }),
    bridgeGrantQuery(db, {
      artifactId: input.shareableId,
      email: context.requester.verifiedEmail,
      grantedAt: prepared.now,
      grantedBy: input.binding.authority.botUserId,
    }),
    db.insertInto('bridge_operations').values({
      id: operationId,
      bridge_authority_id: authority.bridgeAuthorityId,
      request_id: context.requestId,
      lease_generation: input.leaseGeneration,
      operation: 'publish',
      requester_stable_id: context.requester.stableId,
      requester_verified_email: context.requester.verifiedEmail,
      requester_display_name: context.requester.displayName,
      artifact_id: input.shareableId,
      version_id: prepared.versionId,
      created_at: prepared.now,
    }),
  )
  if (prepared.versionFiles?.length) {
    queries.push(
      ...chunkArray(prepared.versionFiles, VERSION_FILE_INSERT_CHUNK_SIZE).map(
        (rows) => db.insertInto('version_files').values(rows),
      ),
    )
  }
  if (input.binding.routingClass === 'dm') {
    queries.push(
      db.insertInto('bridge_dm_artifacts').values({
        artifact_id: input.shareableId,
        bridge_authority_id: authority.bridgeAuthorityId,
        requester_stable_id: context.requester.stableId,
        created_at: prepared.now,
      }),
    )
  }
  queries.push(
    artifactCreatedEventQuery(db, { versionId: prepared.versionId }),
    db
      .updateTable('bridge_requests')
      .set({
        status: 'completed',
        mapping_id: mappingId,
        result_artifact_id: input.shareableId,
        result_version_id: prepared.versionId,
        mapping_created: createMapping || input.binding.mappingCreated ? 1 : 0,
        project_created: createMapping || input.binding.projectCreated ? 1 : 0,
        updated_at: prepared.now,
      })
      .where('bridge_authority_id', '=', authority.bridgeAuthorityId)
      .where('request_id', '=', context.requestId)
      .where('status', '=', 'leased')
      .where('lease_generation', '=', input.leaseGeneration),
  )
  try {
    await runD1Batch(db, ...queries)
    return { kind: 'ok' }
  } catch (error) {
    console.error('bridge_publish_commit_failed', {
      authority_id: authority.bridgeAuthorityId,
      request_id: context.requestId,
      shareable_id: input.shareableId,
      error,
    })
    await cleanupFailedShareable(db, input.shareableId)
    if (createMapping) {
      await cleanupFailedMapping(db, mappingId!, projectId)
      const concurrent = await resolveConversation(
        db,
        authority.bridgeAuthorityId,
        context.conversation.ids,
      )
      if (concurrent.kind === 'ok' && concurrent.mapping !== null) {
        return { kind: 'conversation-identity-conflict' }
      }
      const workspace = await db
        .selectFrom('workspaces')
        .select('plan')
        .where('id', '=', authority.workspaceId)
        .executeTakeFirst()
      if (
        workspace &&
        (await activeProjectCountAtLimit(
          db,
          authority.workspaceId,
          projectLimitForPlan(workspace.plan),
        ))
      ) {
        return { kind: 'project-limit-reached' }
      }
      const nameTaken = await db
        .selectFrom('artifact_containers')
        .select('id')
        .where('workspace_id', '=', authority.workspaceId)
        .where(sql<boolean>`name = ${projectName} COLLATE NOCASE`)
        .where('archived_at', 'is', null)
        .executeTakeFirst()
      if (nameTaken) return { kind: 'project-name-conflict' }
    }
    return { kind: 'upload-failed' }
  }
}

function guardedProjectInsert(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
  projectId: string,
  projectName: string,
  now: string,
  limit: number | null,
) {
  let query = db
    .selectFrom('bridge_requests as request')
    .innerJoin(
      'bridge_authorities as bridge',
      'bridge.id',
      'request.bridge_authority_id',
    )
    .innerJoin('users as bot', 'bot.id', 'bridge.bot_user_id')
    .innerJoin(
      'artifact_containers as fallback',
      'fallback.id',
      'bridge.fallback_project_id',
    )
    .select((eb) => [
      eb.val(projectId).as('id'),
      eb.val(authority.workspaceId).as('workspace_id'),
      eb.val('project' as const).as('kind'),
      eb.val(null).as('owner_user_id'),
      eb.ref('bridge.bot_user_id').as('created_by_id'),
      eb.val(projectName).as('name'),
      eb.val(null).as('description'),
      eb.val(null).as('archived_at'),
      eb.val(now).as('created_at'),
      eb.val(now).as('updated_at'),
      eb.val('workspace' as const).as('base_visibility'),
    ])
    .where('request.bridge_authority_id', '=', authority.bridgeAuthorityId)
    .where('request.request_id', '=', context.requestId)
    .where('request.status', '=', 'leased')
    .where('bridge.workspace_id', '=', authority.workspaceId)
    .where('bridge.agent_profile_id', '=', authority.agentProfileId)
    .where('bridge.source_kind', '=', authority.sourceKind)
    .where('bridge.source_installation_id', '=', authority.sourceInstallationId)
    .where('bridge.external_workspace_id', '=', authority.externalWorkspaceId)
    .where('bot.bot_stopped_at', 'is', null)
    .where('fallback.workspace_id', '=', authority.workspaceId)
    .where('fallback.kind', '=', 'project')
    .where('fallback.archived_at', 'is', null)
  if (limit !== null) {
    query = query.where(
      sql<boolean>`(
        SELECT COUNT(*) FROM artifact_containers
        WHERE workspace_id = ${authority.workspaceId}
          AND kind = 'project'
          AND archived_at IS NULL
      ) < ${limit}`,
    )
  }
  return db
    .insertInto('artifact_containers')
    .columns([
      'id',
      'workspace_id',
      'kind',
      'owner_user_id',
      'created_by_id',
      'name',
      'description',
      'archived_at',
      'created_at',
      'updated_at',
      'base_visibility',
    ])
    .expression(query)
}

function guardedShareableInsert(
  db: Kysely<DB>,
  input: {
    authority: BridgeAuthority
    context: TrustedBridgeContext
    intent: BridgeIntent
    binding: BoundBridgeRequest
    mappingId: string | null
    projectId: string
    shareableId: string
    prepared: PreparedBridgeArtifact
    leaseGeneration: string
  },
) {
  const common = [
    sql<string>`${input.shareableId}`.as('id'),
    sql<string>`${input.authority.workspaceId}`.as('workspace_id'),
    sql<string>`${input.binding.authority.botUserId}`.as('owner_user_id'),
    sql<null>`NULL`.as('slug'),
    sql<string>`${input.prepared.entrypointPath.slice(1)}`.as('name'),
    sql<string | null>`${input.prepared.derivedTitle}`.as('derived_title'),
    sql<string | null>`${input.intent.title}`.as('title_override'),
    sql<null>`NULL`.as('description'),
    sql<string>`${input.prepared.artifactKind}`.as('artifact_kind'),
  ]
  const tail = [
    sql<null>`NULL`.as('link_expires_at'),
    sql<string>`${input.prepared.versionId}`.as('current_version_id'),
    sql<string>`${input.prepared.now}`.as('created_at'),
    sql<string>`${input.prepared.now}`.as('updated_at'),
    sql<string>`${input.projectId}`.as('container_id'),
    sql<null>`NULL`.as('last_accessed_at'),
    sql<string>`${input.authority.agentProfileId}`.as(
      'created_by_agent_profile_id',
    ),
  ]
  const columns = [
    'id',
    'workspace_id',
    'owner_user_id',
    'slug',
    'name',
    'derived_title',
    'title_override',
    'description',
    'artifact_kind',
    'visibility',
    'link_expires_at',
    'current_version_id',
    'created_at',
    'updated_at',
    'container_id',
    'last_accessed_at',
    'created_by_agent_profile_id',
  ] as const

  if (input.binding.routingClass === 'dm') {
    return db
      .insertInto('shareables')
      .columns(columns)
      .expression((eb) =>
        eb
          .selectFrom('bridge_requests as request')
          .innerJoin(
            'bridge_authorities as bridge',
            'bridge.id',
            'request.bridge_authority_id',
          )
          .innerJoin('users as bot', 'bot.id', 'bridge.bot_user_id')
          .innerJoin(
            'artifact_containers as fallback',
            'fallback.id',
            'bridge.fallback_project_id',
          )
          .select([
            ...common,
            eb.val('private' as const).as('visibility'),
            ...tail,
          ])
          .where(
            'request.bridge_authority_id',
            '=',
            input.authority.bridgeAuthorityId,
          )
          .where('request.request_id', '=', input.context.requestId)
          .where('request.status', '=', 'leased')
          .where('request.lease_generation', '=', input.leaseGeneration)
          .where('bridge.fallback_project_id', '=', input.projectId)
          .where('bridge.workspace_id', '=', input.authority.workspaceId)
          .where('bot.bot_stopped_at', 'is', null)
          .where('fallback.workspace_id', '=', input.authority.workspaceId)
          .where('fallback.kind', '=', 'project')
          .where('fallback.archived_at', 'is', null),
      )
  }
  return db
    .insertInto('shareables')
    .columns(columns)
    .expression((eb) =>
      eb
        .selectFrom('bridge_requests as request')
        .innerJoin(
          'bridge_authorities as bridge',
          'bridge.id',
          'request.bridge_authority_id',
        )
        .innerJoin('users as bot', 'bot.id', 'bridge.bot_user_id')
        .innerJoin('bridge_conversations as mapping', (join) =>
          join
            .on('mapping.id', '=', input.mappingId!)
            .onRef(
              'mapping.bridge_authority_id',
              '=',
              'request.bridge_authority_id',
            ),
        )
        .innerJoin(
          'artifact_containers as project',
          'project.id',
          'mapping.project_id',
        )
        .select([
          ...common,
          sql<'private' | 'project'>`CASE
            WHEN ${input.intent.requestedAudience} = 'private'
              OR mapping.privacy_ceiling = 'private'
              OR project.base_visibility = 'private'
            THEN 'private'
            ELSE 'project'
          END`.as('visibility'),
          ...tail,
        ])
        .where(
          'request.bridge_authority_id',
          '=',
          input.authority.bridgeAuthorityId,
        )
        .where('request.request_id', '=', input.context.requestId)
        .where('request.status', '=', 'leased')
        .where('request.lease_generation', '=', input.leaseGeneration)
        .where('mapping.id', '=', input.mappingId!)
        .where('mapping.project_id', '=', input.projectId)
        .where('bridge.workspace_id', '=', input.authority.workspaceId)
        .where('bot.bot_stopped_at', 'is', null)
        .where('project.workspace_id', '=', input.authority.workspaceId)
        .where('project.kind', '=', 'project')
        .where('project.archived_at', 'is', null),
    )
}

function publicContextFresh(context: TrustedBridgeContext, now: Date) {
  const value = context.conversation.privacyCheckedAt
  if (!value) return false
  const checkedAt = Date.parse(value)
  const age = now.getTime() - checkedAt
  return Number.isFinite(checkedAt) && age <= 60_000 && age >= -5_000
}

async function cleanupFailedShareable(db: Kysely<DB>, shareableId: string) {
  try {
    await db.deleteFrom('shareables').where('id', '=', shareableId).execute()
  } catch {
    // Production D1 batches are atomic; this is test-adapter compensation.
  }
}

async function cleanupFailedMapping(
  db: Kysely<DB>,
  mappingId: string,
  projectId: string,
) {
  try {
    await db
      .deleteFrom('bridge_conversation_ids')
      .where('mapping_id', '=', mappingId)
      .execute()
    await db
      .deleteFrom('bridge_conversations')
      .where('id', '=', mappingId)
      .execute()
  } catch {
    // A surviving reference means the failed path converged elsewhere.
  }
  await deleteEmptyProject(db, projectId)
}

async function fileSha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function acquireRequestLease(
  db: Kysely<DB>,
  authorityId: string,
  requestId: string,
  digest: string,
  now: Date,
): Promise<
  | { kind: 'acquired'; generation: string }
  | { kind: 'completed' }
  | { kind: 'idempotency-in-progress' }
  | { kind: 'idempotency-mismatch' }
> {
  const current = await db
    .selectFrom('bridge_requests')
    .select(['stable_digest', 'status', 'lease_expires_at'])
    .where('bridge_authority_id', '=', authorityId)
    .where('request_id', '=', requestId)
    .executeTakeFirst()
  if (!current) return { kind: 'idempotency-mismatch' }
  if (current.stable_digest !== null && current.stable_digest !== digest) {
    return { kind: 'idempotency-mismatch' }
  }
  if (current.status === 'completed') return { kind: 'completed' }
  if (
    current.status === 'leased' &&
    current.lease_expires_at !== null &&
    current.lease_expires_at > now.toISOString()
  ) {
    return { kind: 'idempotency-in-progress' }
  }
  const generation = nanoid()
  const expiresAt = new Date(now.getTime() + REQUEST_LEASE_MS).toISOString()
  const updated = await db
    .updateTable('bridge_requests')
    .set({
      stable_digest: digest,
      status: 'leased',
      lease_generation: generation,
      lease_expires_at: expiresAt,
      updated_at: now.toISOString(),
    })
    .where('bridge_authority_id', '=', authorityId)
    .where('request_id', '=', requestId)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'binding'),
        eb.and([
          eb('status', '=', 'leased'),
          eb('lease_expires_at', '<=', now.toISOString()),
        ]),
      ]),
    )
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows ?? 0n) === 1) {
    return { kind: 'acquired', generation }
  }
  const raced = await db
    .selectFrom('bridge_requests')
    .select(['stable_digest', 'status'])
    .where('bridge_authority_id', '=', authorityId)
    .where('request_id', '=', requestId)
    .executeTakeFirst()
  if (raced?.stable_digest !== digest) return { kind: 'idempotency-mismatch' }
  return raced?.status === 'completed'
    ? { kind: 'completed' }
    : { kind: 'idempotency-in-progress' }
}

async function releaseRequestLease(
  db: Kysely<DB>,
  authorityId: string,
  requestId: string,
  generation: string,
) {
  await db
    .updateTable('bridge_requests')
    .set({
      stable_digest: null,
      status: 'binding',
      lease_generation: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .where('bridge_authority_id', '=', authorityId)
    .where('request_id', '=', requestId)
    .where('status', '=', 'leased')
    .where('lease_generation', '=', generation)
    .execute()
}

async function readBridgeResult(
  db: Kysely<DB>,
  authorityId: string,
  requestId: string,
  requesterEmail: string,
  origin: string,
  replayed: boolean,
): Promise<{ kind: 'ok'; result: BridgeRequestSuccess } | null> {
  const row = await db
    .selectFrom('bridge_requests as request')
    .innerJoin(
      'shareables as artifact',
      'artifact.id',
      'request.result_artifact_id',
    )
    .innerJoin(
      'artifact_containers as project',
      'project.id',
      'artifact.container_id',
    )
    .select([
      'request.result_version_id',
      'request.mapping_created',
      'request.project_created',
      'artifact.id as artifact_id',
      'artifact.name as artifact_name',
      'artifact.derived_title',
      'artifact.title_override',
      'artifact.visibility',
      'project.id as project_id',
      'project.name as project_name',
      'project.base_visibility',
    ])
    .where('request.bridge_authority_id', '=', authorityId)
    .where('request.request_id', '=', requestId)
    .where('request.status', '=', 'completed')
    .executeTakeFirst()
  if (!row) return null
  const visibility =
    row.visibility === 'private' || row.base_visibility === 'private'
      ? ('private' as const)
      : ('workspace' as const)
  if (visibility === 'private') {
    const granted = await ensureReplayGrant(
      db,
      row.artifact_id,
      requesterEmail,
      authorityId,
    )
    if (!granted) return null
  }
  const cleanOrigin = origin.replace(/\/$/, '')
  return {
    kind: 'ok',
    result: {
      artifact: {
        id: row.artifact_id,
        url: `${cleanOrigin}/a/${row.artifact_id}`,
        title: truncateBridgeTitle(
          row.title_override ?? row.derived_title ?? row.artifact_name,
        ),
      },
      project: { id: row.project_id, name: row.project_name },
      visibility,
      versionId: row.result_version_id,
      replayed,
      mappingCreated: row.mapping_created === 1,
      projectCreated: row.project_created === 1,
    },
  }
}

function bridgeGrantQuery(
  db: Kysely<DB>,
  input: {
    artifactId: string
    email: string
    grantedAt: string
    grantedBy: string
    lease?: {
      authorityId: string
      requestId: string
      generation: string
    }
  },
) {
  const normalizedEmail = input.email.toLowerCase()
  return db
    .insertInto('shareable_grants')
    .columns(['shareable_id', 'granted_email', 'granted_at', 'granted_by'])
    .expression((eb) => {
      let query = eb
        .selectFrom('shareables')
        .select([
          eb.val(input.artifactId).as('shareable_id'),
          eb.val(normalizedEmail).as('granted_email'),
          eb.val(input.grantedAt).as('granted_at'),
          eb.val(input.grantedBy).as('granted_by'),
        ])
        .where('id', '=', input.artifactId)
        .where(bridgeGrantAvailableSql(input.artifactId, normalizedEmail))
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM shareable_grants existing
            WHERE existing.shareable_id = ${input.artifactId}
              AND ${lowerEmail('existing.granted_email')} = ${normalizedEmail}
          )`,
        )
      if (input.lease) query = query.where(bridgeLeaseActiveSql(input.lease))
      return query
    })
    .onConflict((conflict) => conflict.doNothing())
}

function bridgeGrantAvailableSql(artifactId: string, email: string) {
  const normalizedEmail = email.toLowerCase()
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM shareable_grants existing
      WHERE existing.shareable_id = ${artifactId}
        AND ${lowerEmail('existing.granted_email')} = ${normalizedEmail}
    )
    OR (
      SELECT COUNT(*) FROM shareable_grants
      WHERE shareable_id = ${artifactId}
    ) < 50
  )`
}

function bridgeLeaseActiveSql(input: {
  authorityId: string
  requestId: string
  generation: string
}) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM bridge_requests active_request
    WHERE active_request.bridge_authority_id = ${input.authorityId}
      AND active_request.request_id = ${input.requestId}
      AND active_request.status = 'leased'
      AND active_request.lease_generation = ${input.generation}
  )`
}

async function bridgeGrantLimitReached(
  db: Kysely<DB>,
  artifactId: string,
  email: string,
) {
  const normalizedEmail = email.toLowerCase()
  const row = await db
    .selectFrom('shareable_grants')
    .select(({ fn }) => [
      fn.countAll<number>().as('count'),
      fn
        .max<number>(
          sql<number>`CASE WHEN ${lowerEmail('granted_email')} = ${normalizedEmail} THEN 1 ELSE 0 END`,
        )
        .as('has_requester'),
    ])
    .where('shareable_id', '=', artifactId)
    .executeTakeFirst()
  return Number(row?.count ?? 0) >= 50 && Number(row?.has_requester ?? 0) === 0
}

async function ensureReplayGrant(
  db: Kysely<DB>,
  artifactId: string,
  email: string,
  authorityId: string,
): Promise<boolean> {
  const normalizedEmail = email.toLowerCase()
  const existing = await db
    .selectFrom('shareable_grants')
    .select('shareable_id')
    .where('shareable_id', '=', artifactId)
    .where(lowerEmail('granted_email'), '=', normalizedEmail)
    .executeTakeFirst()
  if (existing) return true
  const count = await db
    .selectFrom('shareable_grants')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('shareable_id', '=', artifactId)
    .executeTakeFirstOrThrow()
  if (Number(count.count) >= 50) return false
  const authority = await db
    .selectFrom('bridge_authorities')
    .select('bot_user_id')
    .where('id', '=', authorityId)
    .executeTakeFirst()
  if (!authority) return false
  try {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: artifactId,
        granted_email: normalizedEmail,
        granted_at: nowIso(),
        granted_by: authority.bot_user_id,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
  } catch {
    return false
  }
  return true
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function truncateBridgeTitle(value: string): string {
  if (value.length <= 200) return value
  const end =
    value.charCodeAt(199) >= 0xd800 && value.charCodeAt(199) <= 0xdbff
      ? 199
      : 200
  return value.slice(0, end)
}
