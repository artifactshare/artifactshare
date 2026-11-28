import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'

export type McpPostAction = 'publish' | 'update'

export interface RecordArtifactPostInput {
  shareableId: string
  userId: string
  workspaceId: string
  clientId: string | null
  action: McpPostAction
  contentHash: string
}

export async function recordArtifactPost(
  db: Kysely<DB>,
  input: RecordArtifactPostInput,
): Promise<void> {
  await db
    .insertInto('mcp_artifact_posts')
    .values({
      id: nanoid(),
      shareable_id: input.shareableId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      client_id: input.clientId,
      action: input.action,
      content_hash: input.contentHash,
      created_at: nowIso(),
    })
    .execute()
}

export async function findRecentPublish(
  db: Kysely<DB>,
  args: { userId: string; contentHash: string; since: string },
): Promise<{ shareableId: string } | null> {
  const row = await db
    .selectFrom('mcp_artifact_posts')
    .select('shareable_id')
    .where('user_id', '=', args.userId)
    .where('action', '=', 'publish')
    .where('content_hash', '=', args.contentHash)
    .where('created_at', '>', args.since)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ? { shareableId: row.shareable_id } : null
}
