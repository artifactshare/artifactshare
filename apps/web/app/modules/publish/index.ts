import type { Compilable, Kysely } from 'kysely'
import { defaultVisibilityFor } from '~/lib/shareable-types'
import type { Visibility } from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
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
  email?: string | null
  emailVerified?: boolean
  workspaceId: string
  hd?: string | null
  msTenantId?: string | null
  locale?: string | null
  kind?: 'human' | 'bot'
}

/**
 * The identity that initiated a publish.
 *
 * The optional authority is deliberately kept on the principal rather than
 * reconstructed in the publish service. This lets the bridge and restricted
 * agent paths carry their existing authorization facts through the common
 * entry point without changing their meaning.
 */
export type Principal = {
  kind: 'human' | 'agent' | 'bot' | 'bridge'
  user: PublishUser
  authority?: CliAuthority | null
}

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
export type PublishIntent = {
  actor: Principal
  destination: PublishDestination
  target: PublishTarget
  content: PublishContent
  visibility?: Visibility
  idempotencyKey?: string
  notify: { slack: boolean }

  /** Server-only execution context; omitted callers use the Worker DB. */
  db?: Kysely<DB>
  waitUntil?: (promise: Promise<unknown>) => void
  auditQuery?: PublishAuditQuery
  agentProfileId?: string | null
  touchArtifactKeyId?: string | null
  preserveName?: boolean
}

export type PublishResult = UploadShareableResult | CreateVersionResult

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
  const containerId =
    intent.destination.kind === 'project' ? intent.destination.id : null
  const visibility =
    intent.visibility ??
    defaultVisibilityFor(
      isOrgWorkspace(user),
      intent.destination.kind === 'project' ? 'project' : 'inbox',
    )

  if (intent.target.kind === 'update') {
    if (intent.content.kind !== 'file') {
      return { kind: 'copy-forbidden' }
    }
    return await createVersion({
      db,
      user: {
        id: user.id,
        email: user.email,
        workspaceId: user.workspaceId,
        hd: user.hd ?? null,
        emailVerified: user.emailVerified ?? false,
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
      ...(intent.agentProfileId !== undefined
        ? { agentProfileId: intent.agentProfileId }
        : {}),
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
    {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified ?? false,
      workspaceId: user.workspaceId,
      hd: user.hd ?? null,
      msTenantId: user.msTenantId ?? null,
    },
    fileFromEntry(intent.content),
    visibility,
    [],
    containerId,
    intent.idempotencyKey ?? null,
    {
      ...(intent.agentProfileId !== undefined
        ? { agentProfileId: intent.agentProfileId }
        : {}),
      slackNotify: intent.notify.slack,
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
  if (typeof File !== 'undefined' && bytes instanceof File) {
    return new File([bytes], entry.path, {
      type: entry.mediaType || bytes.type,
    })
  }
  if (typeof Blob !== 'undefined' && bytes instanceof Blob) {
    return new File([bytes], entry.path, {
      type: entry.mediaType ?? bytes.type,
    })
  }
  if (bytes instanceof ArrayBuffer) {
    return new File([bytes], entry.path, { type: entry.mediaType ?? '' })
  }
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return new File([view], entry.path, { type: entry.mediaType ?? '' })
}
