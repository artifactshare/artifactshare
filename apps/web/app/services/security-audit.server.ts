import type { Compilable, Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { DB } from '~/types/db'

export type SecurityAuditAction = 'artifact.publish' | 'artifact.update'

export function securityAuditInsertQuery(
  db: Kysely<DB>,
  input: {
    workspaceId: string
    actorId: string
    clientId: string | null
    development: boolean
    subjectId: string
    action: SecurityAuditAction
    createdAt: string
  },
): Compilable<unknown> {
  return db.insertInto('security_audit_records').values({
    id: nanoid(),
    workspace_id: input.workspaceId,
    actor_type: 'user',
    actor_id: input.actorId,
    client_type: input.development ? 'development' : 'oauth_client',
    client_id: input.clientId,
    subject_type: 'shareable',
    subject_id: input.subjectId,
    action: input.action,
    created_at: input.createdAt,
  })
}

const SECURITY_AUDIT_RETENTION_DAYS = 400
export const SECURITY_AUDIT_CLEANUP_BATCH_SIZE = 1000

export async function cleanupExpiredSecurityAuditRecords(
  db: Kysely<DB>,
  now: Date,
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - SECURITY_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const result = await db
    .deleteFrom('security_audit_records')
    .where(
      'id',
      'in',
      db
        .selectFrom('security_audit_records')
        .select('id')
        .where('created_at', '<=', cutoff)
        .orderBy('created_at')
        .orderBy('id')
        .limit(SECURITY_AUDIT_CLEANUP_BATCH_SIZE),
    )
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}
