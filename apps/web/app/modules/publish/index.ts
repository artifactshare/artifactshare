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
  type UploadShareableResult,
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
  | { kind: 'site'; files: FileEntry[] }

/** The single intent shape shared by all publish entry points. */
type PublishIntentBase = {
  actor: Principal
  content: PublishContent
  visibility?: Visibility
  idempotencyKey?: string
  notify: { slack: boolean }
  grantEmails?: ReadonlyArray<string>
  linkExpiresAt?: string | null

  /** Server-only execution context; omitted callers use the Worker DB. */
  db?: Kysely<DB>
  waitUntil?: (promise: Promise<unknown>) => void
  auditQuery?: PublishAuditQuery
  touchArtifactKeyId?: string | null
  preserveName?: boolean
}

export type PublishIntent =
  | (PublishIntentBase & {
      destination: PublishDestination
      target: Extract<PublishTarget, { kind: 'create' }>
    })
  | (PublishIntentBase & {
      destination?: undefined
      target: Extract<PublishTarget, { kind: 'update' }>
    })

export type PublishResult =
  | UploadShareableResult
  | CreateVersionResult
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
  let containerId: string | null = null
  if (intent.target.kind === 'create') {
    const destination = intent.destination
    if (!destination) return { kind: 'forbidden' }
    containerId = destination.kind === 'project' ? destination.id : null
  } else if (authority?.kind === 'agent') {
    containerId = authority.projectId
  }
  const visibility =
    intent.visibility ??
    (intent.grantEmails && intent.grantEmails.length > 0
      ? 'private'
      : defaultVisibilityFor(
          isOrgWorkspace(normalizedUser),
          containerId === null ? 'inbox' : 'project',
        ))
  const authorityAgentProfileId =
    authority?.kind === 'agent' || authority?.kind === 'bridge'
      ? authority.agentProfileId
      : null
  const agentProfileId = authorityAgentProfileId ?? undefined

  if (authority?.kind === 'agent') {
    const agentUser = normalizedUser.email
      ? {
          workspaceId: normalizedUser.workspaceId,
          email: normalizedUser.email,
        }
      : null
    if (
      agentUser === null ||
      visibility === 'private' ||
      visibility === 'link' ||
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

  if (intent.target.kind === 'update') {
    if (authority?.kind === 'agent' && !intent.target.expectedVersionId) {
      return { kind: 'expected-version-required' }
    }
    if (intent.content.kind !== 'file') {
      return { kind: 'copy-forbidden' }
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

  if (intent.content.kind !== 'file') {
    // The session-based static-site migration is introduced by the browser
    // and bridge children. Keep the first skeleton explicit rather than
    // silently treating a bundle as a single file.
    return { kind: 'unsupported-type' }
  }

  return await uploadShareable(
    db,
    normalizedUser,
    fileFromEntry(intent.content),
    visibility,
    intent.grantEmails ?? [],
    containerId,
    intent.idempotencyKey ?? null,
    {
      ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      slackNotify: intent.notify.slack,
      ...(intent.linkExpiresAt !== undefined
        ? { linkExpiresAt: intent.linkExpiresAt }
        : {}),
      ...(intent.auditQuery ? { auditQuery: intent.auditQuery } : {}),
    },
  )
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
