import type { Kysely } from 'kysely'
import { normalizeGrantEmail } from '~/lib/grant-emails'
import type { DB } from '~/types/db'

export interface GrantResolvedUser {
  id: string
  name: string | null
  image: string | null
  kind: 'human' | 'bot'
}

export async function resolveGrantUsersByEmail(
  db: Kysely<DB>,
  emails: ReadonlyArray<string>,
): Promise<{ email: string; user: GrantResolvedUser | null }[]> {
  if (emails.length === 0) return []

  const rows = await db
    .selectFrom('users')
    .select(['id', 'name', 'image', 'email', 'kind'])
    .where('email', 'in', emails)
    .execute()
  const byEmail = new Map<string, GrantResolvedUser>()
  for (const row of rows) {
    byEmail.set(normalizeGrantEmail(row.email), {
      id: row.id,
      name: row.name,
      image: row.image,
      kind: row.kind,
    })
  }
  return emails.map((email) => ({
    email,
    user: byEmail.get(email) ?? null,
  }))
}
