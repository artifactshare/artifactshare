import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { batchRows, runD1BatchWithResults } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { workspaceAccessRevokedSql } from '~/modules/access'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'

export async function adoptPublisherArtifact(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  authority: CliAuthority | null,
  browserSession: boolean,
  id: string,
  clientId: string,
): Promise<
  { kind: 'ok' } | { kind: 'scope-denied' | 'not-found' | 'conflict' }
> {
  if (authority ? authority.kind !== 'unrestricted' : !browserSession)
    return { kind: 'scope-denied' }
  const eligible = sql<boolean>`shareables.id = ${id}
    AND shareables.owner_user_id = ${user.id}
    AND shareables.workspace_id = ${user.workspaceId}
    AND shareables.artifact_kind IN ('html_page', 'markdown_page', 'static_site')
    AND NOT ${workspaceAccessRevokedSql(sql.ref('shareables.workspace_id'), user.id)}
    AND EXISTS (SELECT 1 FROM publisher_clients pc JOIN users u ON u.id = pc.user_id
      WHERE pc.id = ${clientId} AND pc.user_id = ${user.id}
      AND pc.workspace_id = shareables.workspace_id AND u.kind = 'human'
      AND u.workspace_id = pc.workspace_id)`
  const row = await db
    .selectFrom('shareables')
    .select(['assigned_publisher_client_id', 'created_by_publisher_client_id'])
    .where(eligible)
    .executeTakeFirst()
  if (!row) return { kind: 'not-found' }
  const guard = sql<boolean>`(${eligible})
    AND shareables.assigned_publisher_client_id IS ${row.assigned_publisher_client_id}
    AND shareables.created_by_publisher_client_id IS ${row.created_by_publisher_client_id}`
  const [, result] = await runD1BatchWithResults(
    db,
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
          .where(guard)
          .select([
            eb.val(nanoid(16)).as('id'),
            'workspace_id',
            eb.val(user.id).as('actor_user_id'),
            eb.val('artifact.publisher_adopted').as('action'),
            eb.val('shareable').as('subject_type'),
            'id as subject_id',
            sql<string>`json_object(
              'artifact_title', COALESCE(shareables.title_override, shareables.derived_title, shareables.name),
              'previous_publisher_client_id', COALESCE(shareables.assigned_publisher_client_id, shareables.created_by_publisher_client_id),
              'previous_publisher_client_name', (SELECT name FROM publisher_clients WHERE id = COALESCE(shareables.assigned_publisher_client_id, shareables.created_by_publisher_client_id)),
              'publisher_client_id', ${clientId},
              'publisher_client_name', (SELECT name FROM publisher_clients WHERE id = ${clientId})
            )`.as('detail'),
            eb.val(nowIso()).as('created_at'),
          ]),
      ),
    db
      .updateTable('shareables')
      .set({ assigned_publisher_client_id: clientId })
      .where(guard)
      .returning('id'),
  )
  if (batchRows(result).length) return { kind: 'ok' }
  // A changed assignment conflicts; loss of ownership, membership or the
  // target client remains indistinguishable from a missing artifact.
  const stillEligible = await db
    .selectFrom('shareables')
    .select('id')
    .where(eligible)
    .executeTakeFirst()
  return stillEligible ? { kind: 'conflict' } : { kind: 'not-found' }
}
