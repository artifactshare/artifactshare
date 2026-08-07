import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'

export async function consumeJti(
  db: Kysely<DB>,
  jti: string,
  expiresAt: string,
): Promise<boolean> {
  const inserted = await db
    .insertInto('sandbox_token_uses')
    .values({ jti, expires_at: expiresAt })
    .onConflict((oc) => oc.column('jti').doNothing())
    .returning('jti')
    .executeTakeFirst()

  return inserted !== undefined
}
