import { artifactSupportsComments, type ArtifactType } from './artifact-type'
import type { CommentSyncAssignment } from './comment-sync'
import {
  evaluateFlagshipMode,
  type FlagshipSource,
  type FlagshipFlagRegistration,
} from './flagship-fallback.server'

export const commentSyncFlag = {
  flagKey: 'comment-sync-engine',
  modes: ['legacy', 'session'],
  defaultMode: 'legacy',
  expiresOn: '2026-12-10',
} as const satisfies FlagshipFlagRegistration

/** Called only in the access-granted loader branch. Expiry is a removal deadline,
 * checked in tests/tooling, never a request-time outage switch. */
export async function commentSyncAssignment(
  source: FlagshipSource & { WORKER_VERSION?: WorkerVersionMetadata },
  input: {
    ownerWorkspaceId: string
    authenticated: boolean
    historical: boolean
    renderType: ArtifactType | null
  },
): Promise<CommentSyncAssignment> {
  const id = source.WORKER_VERSION?.id
  const build =
    id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      id,
    ) &&
    id !== '00000000-0000-0000-0000-000000000000'
      ? id
      : 'unknown'
  if (
    !input.authenticated ||
    input.historical ||
    !artifactSupportsComments(input.renderType)
  )
    return { mode: 'legacy', build }
  const result = await evaluateFlagshipMode(
    // Preserve the shared helper's nonproduction missing-binding override.
    source,
    {
      ...commentSyncFlag,
      context: {
        targetingKey: input.ownerWorkspaceId,
        workspaceId: input.ownerWorkspaceId,
      },
    },
  )
  return { mode: result.mode, build }
}
