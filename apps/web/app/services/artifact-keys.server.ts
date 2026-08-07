import type { Kysely } from 'kysely'
import { nowIso } from '~/lib/datetime'
import type { ArtifactKind, Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'
import { resolveUploadContainer } from './projects.server'

// Mirrored as MAX_PUBLISH_KEY_LENGTH in packages/cli (separate package).
export const ARTIFACT_KEY_MAX_LENGTH = 128

export function normalizeArtifactKey(raw: string): string | null {
  const key = raw.trim()
  if (key.length === 0 || key.length > ARTIFACT_KEY_MAX_LENGTH) return null
  return key
}

export type ArtifactKeyKindGroup = 'single_file' | 'static_site'

export type ResolveArtifactKeyResult =
  | { kind: 'create'; containerId: string }
  | {
      kind: 'update'
      keyId: string
      shareableId: string
      artifactKind: ArtifactKind
      visibility: Visibility
      linkExpiresAt: string | null
    }
  | { kind: 'invalid-container' }
  | { kind: 'key-target-moved' }
  | { kind: 'key-kind-mismatch' }

export async function resolveArtifactKey(
  db: Kysely<DB>,
  user: { id: string; emailVerified: boolean; workspaceId: string },
  requestedContainerId: string | null,
  stableKey: string,
  expected: ArtifactKeyKindGroup,
): Promise<ResolveArtifactKeyResult> {
  const destination = await resolveUploadContainer(
    db,
    user,
    requestedContainerId,
    nowIso(),
  )
  if (destination.kind !== 'ok') return { kind: 'invalid-container' }

  const row = await db
    .selectFrom('artifact_keys')
    .innerJoin('shareables', 'shareables.id', 'artifact_keys.shareable_id')
    .select([
      'artifact_keys.id as key_id',
      'artifact_keys.container_id as key_container_id',
      'shareables.id as shareable_id',
      'shareables.container_id as shareable_container_id',
      'shareables.workspace_id as shareable_workspace_id',
      'shareables.owner_user_id as shareable_owner_user_id',
      'shareables.artifact_kind',
      'shareables.visibility',
      'shareables.link_expires_at',
    ])
    .where('artifact_keys.owner_user_id', '=', user.id)
    .where('artifact_keys.container_id', '=', destination.containerId)
    .where('artifact_keys.stable_key', '=', stableKey)
    .executeTakeFirst()
  if (!row) return { kind: 'create', containerId: destination.containerId }

  if (
    row.shareable_container_id !== row.key_container_id ||
    row.shareable_workspace_id !== user.workspaceId ||
    row.shareable_owner_user_id !== user.id
  ) {
    return { kind: 'key-target-moved' }
  }
  const group: ArtifactKeyKindGroup =
    row.artifact_kind === 'static_site' ? 'static_site' : 'single_file'
  if (group !== expected) return { kind: 'key-kind-mismatch' }

  return {
    kind: 'update',
    keyId: row.key_id,
    shareableId: row.shareable_id,
    artifactKind: row.artifact_kind,
    visibility: row.visibility,
    linkExpiresAt: row.link_expires_at,
  }
}
