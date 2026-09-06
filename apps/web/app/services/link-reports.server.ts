import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { LinkReportReason } from '~/lib/link-report'
import type { DB } from '~/types/db'

export type LinkReportInput = {
  reason: LinkReportReason
  note: string | null
  viewerUrl: string
}

export async function recordLinkReport(
  db: Kysely<DB>,
  shareableId: string,
  input: LinkReportInput,
  reportedAt = new Date().toISOString(),
): Promise<'recorded' | 'suppressed' | 'not-found'> {
  const cutoff = new Date(
    Date.parse(reportedAt) - 24 * 60 * 60 * 1000,
  ).toISOString()
  const event = await db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'payload',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('shareables')
        .select([
          eb.val(nanoid()).as('id'),
          'workspace_id',
          eb.val('link_reported' as const).as('type'),
          'id',
          eb.val(null).as('actor_user_id'),
          eb.val(nanoid()).as('subject_id'),
          eb
            .val(
              JSON.stringify({
                reason: input.reason,
                note: input.note,
                viewerUrl: input.viewerUrl,
              }),
            )
            .as('payload'),
          eb.val(reportedAt).as('created_at'),
        ])
        .where('id', '=', shareableId)
        .where('visibility', '=', 'link')
        .where(
          sql<boolean>`(
            SELECT COUNT(*)
            FROM events AS recent_report
            WHERE recent_report.shareable_id = shareables.id
              AND recent_report.type = 'link_reported'
              AND recent_report.created_at >= ${cutoff}
          ) < 20`,
        ),
    )
    .returning('workspace_id')
    .executeTakeFirst()
  if (!event) {
    const shareable = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', shareableId)
      .where('visibility', '=', 'link')
      .executeTakeFirst()
    return shareable ? 'suppressed' : 'not-found'
  }

  console.warn('artifactshare_link_report', {
    shareableId,
    workspaceId: event.workspace_id,
    reason: input.reason,
    viewerUrl: input.viewerUrl,
  })
  return 'recorded'
}
