import type { Compilable, Kysely } from 'kysely'
import { defaultVisibilityFor } from '~/lib/shareable-types'
import type { Visibility } from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
import { isAgentPublishableDestination } from '~/services/agent-scope.server'
import type { CliAuthority } from '~/services/cli-authority.server'
import {
  createVersion,
  uploadShareable,
  type CreateVersionResult,
  type UpdateStaticSiteBundleResult,
  type UploadShareableResult,
  type UploadStaticSiteBundleResult,
} from '~/services/shareables.server'
import { withDb } from '~/services/db.server'
import type { DB } from '~/types/db'

/** The user-shaped data required by the existing publish service. */
export type PublishUser = {
  id: string
  kind: 'human' | 'bot'
  email?: string | null
  emailVerified?: boolean
  workspaceId: string
  hd?: string | null
  msTenantId?: string | null
}

/**
 * The identity that initiated a publish.
 *
 * The optional authority is deliberately kept on the principal rather than
 * reconstructed in the publish service. This lets the bridge and restricted
 * agent paths carry their existing authorization facts through the common
 * entry point without changing their meaning.
 */
type UnrestrictedAuthority = Extract<CliAuthority, { kind: 'unrestricted' }>
type BootstrapAuthority = Extract<CliAuthority, { kind: 'bootstrap' }>
type AgentAuthority = Extract<CliAuthority, { kind: 'agent' }>
type BridgeAuthority = Extract<CliAuthority, { kind: 'bridge' }>
type HumanPublishUser = PublishUser & { kind: 'human' }
type BotPublishUser = PublishUser & { kind: 'bot' }

export type Principal =
  | {
      kind: 'human'
      user: HumanPublishUser
      authority?: UnrestrictedAuthority | null
    }
  | { kind: 'bootstrap'; user: PublishUser; authority: BootstrapAuthority }
  | { kind: 'agent'; user: PublishUser; authority: AgentAuthority }
  | { kind: 'bot'; user: BotPublishUser; authority: AgentAuthority }
  | { kind: 'bridge'; user: PublishUser; authority: BridgeAuthority }

export type FileEntry = {
  path: string
  bytes: ArrayBuffer | ArrayBufferView | Blob
  mediaType?: string
}

type PublishAuditQuery = (input: {
  workspaceId: string
  shareableId: string
  createdAt: string
}) => Compilable<unknown>

export type PublishDestination =
  | { kind: 'home'; id?: undefined }
  | { kind: 'project'; id: string }

export type PublishTarget =
  | { kind: 'create' }
  | {
      kind: 'update'
      artifactId: string
      expectedVersionId?: string
    }

export type PublishContent =
  | {
      kind: 'file'
      path: string
      bytes: FileEntry['bytes']
      mediaType?: string
    }
  | {
      kind: 'site'
      session: StaticSiteContentSessionAdapter
    }

export type StaticSiteContentSessionContext = {
  db: Kysely<DB>
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    workspaceId: string
    hd: string | null
    msTenantId: string | null
  }
  authority: CliAuthority | null
  target: PublishTarget
  containerId: string | null
  idempotencyKey: string | null
  touchArtifactKeyId: string | null
  waitUntil?: (promise: Promise<unknown>) => void
}

/** Internal outcome returned by a streaming static-site content adapter. */
export type StaticSiteContentSessionResult =
  | UploadStaticSiteBundleResult
  | UpdateStaticSiteBundleResult
  | {
      kind: 'static-site-update-ok'
      result: Extract<UpdateStaticSiteBundleResult, { kind: 'ok' }>
      shareUrlVisibility: Visibility
    }
  | { kind: 'copy-forbidden' }
  | { kind: 'static-site-session-not-found' }
  | { kind: 'static-site-visibility-forbidden' }
  | { kind: 'invalid-visibility' }
  | { kind: 'link-expiry-invalid' }
  | { kind: 'missing-file' }
  | { kind: 'invalid-grants' }
  | { kind: 'too-many-parts' }
  | { kind: 'invalid-form-data' }

/** Transport adapter used to feed a static-site upload session. */
export type StaticSiteContentSessionAdapter = {
  publish(
    context: StaticSiteContentSessionContext,
  ): Promise<StaticSiteContentSessionResult>
}

/** The single intent shape shared by all publish entry points. */
type PublishIntentBase = {
  actor: Principal
  content: PublishContent

  /** Server-only execution context; omitted callers use the Worker DB. */
  db?: Kysely<DB>
  waitUntil?: (promise: Promise<unknown>) => void
  auditQuery?: PublishAuditQuery
}

type PublishCreateIntent = PublishIntentBase & {
  destination: PublishDestination
  target: Extract<PublishTarget, { kind: 'create' }>
  visibility?: Visibility
  idempotencyKey?: string
  notify: { slack: boolean }
  grantEmails?: ReadonlyArray<string>
  linkExpiresAt?: string | null
}

type PublishUpdateIntent = PublishIntentBase & {
  destination?: undefined
  target: Extract<PublishTarget, { kind: 'update' }>
  touchArtifactKeyId?: string | null
  preserveName?: boolean
}

export type PublishIntent = PublishCreateIntent | PublishUpdateIntent

export type PublishResult =
  | UploadShareableResult
  | CreateVersionResult
  | StaticSiteContentSessionResult
  | { kind: 'forbidden' }
  | { kind: 'expected-version-required' }

type FileContent = Extract<PublishContent, { kind: 'file' }>
type SiteContent = Extract<PublishContent, { kind: 'site' }>
type PublishBoundaryFailure =
  | { kind: 'forbidden' }
  | { kind: 'expected-version-required' }

/**
 * Publish through the common boundary.
 *
 * This first implementation is intentionally an adapter: the existing
 * service remains the source of behavior while callers migrate to the
 * intent-shaped API. Later migrations can move the transaction and recovery
 * implementation behind this function without changing an entry point again.
 */
export function publish(
  intent: PublishCreateIntent & { content: FileContent },
): Promise<UploadShareableResult | PublishBoundaryFailure>
export function publish(
  intent: PublishUpdateIntent & { content: FileContent },
): Promise<CreateVersionResult | PublishBoundaryFailure>
export function publish(
  intent: PublishIntent & { content: SiteContent },
): Promise<StaticSiteContentSessionResult | PublishBoundaryFailure>
export async function publish(intent: PublishIntent): Promise<PublishResult> {
  if (intent.db) return await publishWithDb(intent, intent.db)
  return await withDb((db) => publishWithDb(intent, db))
}

async function publishWithDb(
  intent: PublishIntent,
  db: Kysely<DB>,
): Promise<PublishResult> {
  const user = intent.actor.user
  const authority = intent.actor.authority ?? null
  if (
    intent.actor.kind === 'bootstrap' ||
    (intent.actor.kind === 'human' && user.kind !== 'human') ||
    (intent.actor.kind === 'bot' && user.kind !== 'bot') ||
    (intent.actor.kind === 'human' &&
      authority !== null &&
      authority.kind !== 'unrestricted') ||
    ((intent.actor.kind === 'agent' || intent.actor.kind === 'bot') &&
      authority?.kind !== 'agent') ||
    (intent.actor.kind === 'bridge' && authority?.kind !== 'bridge')
  ) {
    return { kind: 'forbidden' }
  }
  // Bridge requests still need their lease, binding, and private-grant
  // validation from bridge-publishing.server.ts. Until that implementation is
  // moved behind this boundary, accepting a bridge principal here would widen
  // its authority, so fail closed.
  if (intent.actor.kind === 'bridge') return { kind: 'forbidden' }
  if (intent.target.kind === 'update' && intent.destination !== undefined) {
    return { kind: 'forbidden' }
  }
  const normalizedUser = {
    id: user.id,
    email: user.email ?? null,
    emailVerified: user.emailVerified ?? false,
    workspaceId: user.workspaceId,
    hd: user.hd ?? null,
    msTenantId: user.msTenantId ?? null,
  }
  const authorityAgentProfileId =
    authority?.kind === 'agent' ? authority.agentProfileId : null
  const agentProfileId = authorityAgentProfileId ?? undefined

  if (isUpdateIntent(intent)) {
    if (authority?.kind === 'agent' && !intent.target.expectedVersionId) {
      return { kind: 'expected-version-required' }
    }
    if (intent.content.kind === 'site') {
      return await intent.content.session.publish({
        db,
        user: normalizedUser,
        authority,
        target: intent.target,
        containerId: null,
        idempotencyKey: null,
        touchArtifactKeyId: intent.touchArtifactKeyId ?? null,
        ...(intent.waitUntil ? { waitUntil: intent.waitUntil } : {}),
      })
    }
    return await createVersion({
      db,
      user: {
        id: user.id,
        email: normalizedUser.email,
        workspaceId: normalizedUser.workspaceId,
        hd: normalizedUser.hd,
        emailVerified: normalizedUser.emailVerified,
      },
      shareableId: intent.target.artifactId,
      file: fileFromEntry(intent.content),
      ...(intent.touchArtifactKeyId
        ? { touchArtifactKeyId: intent.touchArtifactKeyId }
        : {}),
      ...(intent.waitUntil ? { waitUntil: intent.waitUntil } : {}),
      ...(intent.preserveName ? { preserveName: true } : {}),
      ...(intent.target.expectedVersionId
        ? { expectedCurrentVersionId: intent.target.expectedVersionId }
        : {}),
      ...(authority ? { authority } : {}),
      ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      ...(intent.auditQuery ? { auditQuery: intent.auditQuery } : {}),
    })
  }

  const createIntent = intent as PublishCreateIntent
  const containerId =
    createIntent.destination.kind === 'project'
      ? createIntent.destination.id
      : null
  const visibility =
    createIntent.visibility ??
    (createIntent.grantEmails && createIntent.grantEmails.length > 0
      ? 'private'
      : defaultVisibilityFor(
          isOrgWorkspace(normalizedUser),
          containerId === null ? 'inbox' : 'project',
        ))

  if (authority?.kind === 'agent') {
    const agentUser = {
      workspaceId: normalizedUser.workspaceId,
      email: normalizedUser.email ?? '',
    }
    if (
      (createIntent.content.kind === 'file' &&
        (visibility === 'private' || visibility === 'link')) ||
      !(await isAgentPublishableDestination(
        db,
        agentUser,
        authority,
        containerId,
      ))
    ) {
      return { kind: 'forbidden' }
    }
  }

  if (createIntent.content.kind === 'site') {
    return await createIntent.content.session.publish({
      db,
      user: normalizedUser,
      authority,
      target: createIntent.target,
      containerId,
      idempotencyKey: createIntent.idempotencyKey ?? null,
      touchArtifactKeyId: null,
      ...(createIntent.waitUntil ? { waitUntil: createIntent.waitUntil } : {}),
    })
  }

  return await uploadShareable(
    db,
    normalizedUser,
    fileFromEntry(createIntent.content),
    visibility,
    createIntent.grantEmails ?? [],
    containerId,
    createIntent.idempotencyKey ?? null,
    {
      ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      ...(createIntent.notify.slack === false ? { slackNotify: false } : {}),
      ...(createIntent.linkExpiresAt !== undefined
        ? { linkExpiresAt: createIntent.linkExpiresAt }
        : {}),
      ...(createIntent.auditQuery
        ? { auditQuery: createIntent.auditQuery }
        : {}),
    },
  )
}

function isUpdateIntent(intent: PublishIntent): intent is PublishUpdateIntent {
  return intent.target.kind === 'update'
}

function fileFromEntry(entry: {
  path: string
  bytes: FileEntry['bytes']
  mediaType?: string
}): File {
  const bytes = entry.bytes
  if (bytes instanceof Blob) {
    return new File([bytes], entry.path, {
      type: entry.mediaType ?? bytes.type,
    })
  }
  if (bytes instanceof ArrayBuffer) {
    return new File([bytes], entry.path, { type: entry.mediaType ?? '' })
  }
  if (!ArrayBuffer.isView(bytes)) {
    throw new TypeError('Publish file bytes must be a buffer or Blob.')
  }
  const view = new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  )
  const copy = new Uint8Array(view)
  return new File([copy.buffer], entry.path, { type: entry.mediaType ?? '' })
}
