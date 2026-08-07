import type { Kysely } from 'kysely'
import { encodeBase64Url } from '~/lib/base64url'
import { isoMsAgo, nowIso } from '~/lib/datetime'
import { computeTextSha256Hex } from '~/lib/sha256'
import type { DB } from '~/types/db'
import { nanoid } from 'nanoid'

const TOKEN_PREFIX = 'ast_'
const TOKEN_RANDOM_BYTES = 32
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 60 * 1000

export type ApiTokenListItem = {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export type CreateApiTokenResult = {
  id: string
  name: string
  createdAt: string
  token: string
}

function generateApiToken(): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return TOKEN_PREFIX + encodeBase64Url(bytes)
}

export function isApiToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX)
}

function hashApiToken(token: string): Promise<string> {
  return computeTextSha256Hex(token)
}

export async function createApiToken(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<CreateApiTokenResult> {
  const token = generateApiToken()
  const tokenHash = await hashApiToken(token)
  const id = nanoid()
  const createdAt = nowIso()

  await db
    .insertInto('api_tokens')
    .values({
      id,
      user_id: userId,
      name,
      token_hash: tokenHash,
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()

  return { id, name, createdAt, token }
}

export async function listApiTokens(
  db: Kysely<DB>,
  userId: string,
): Promise<ApiTokenListItem[]> {
  const rows = await db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }))
}

export async function revokeApiToken(
  db: Kysely<DB>,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await db
    .updateTable('api_tokens')
    .set({ revoked_at: nowIso() })
    .where('id', '=', tokenId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()

  return Number(result.numUpdatedRows) > 0
}

export type ApiTokenUser = {
  id: string
  email: string
  email_verified: number
  name: string | null
  image: string | null
  workspace_id: string
  locale: string | null
  tokenHash: string
}

export async function findUserByApiToken(
  db: Kysely<DB>,
  token: string,
): Promise<ApiTokenUser | null> {
  const tokenHash = await hashApiToken(token)
  const row = await db
    .selectFrom('api_tokens')
    .innerJoin('users', 'users.id', 'api_tokens.user_id')
    .select([
      'users.id',
      'users.email',
      'users.email_verified',
      'users.name',
      'users.image',
      'users.workspace_id',
      'users.locale',
    ])
    .where('api_tokens.token_hash', '=', tokenHash)
    .where('api_tokens.revoked_at', 'is', null)
    .executeTakeFirst()

  if (!row) return null
  return { ...row, tokenHash }
}

export async function touchApiTokenLastUsedByHash(
  db: Kysely<DB>,
  tokenHash: string,
): Promise<void> {
  const touchBefore = isoMsAgo(LAST_USED_TOUCH_INTERVAL_MS)

  await db
    .updateTable('api_tokens')
    .set({ last_used_at: nowIso() })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('last_used_at', 'is', null),
        eb('last_used_at', '<', touchBefore),
      ]),
    )
    .execute()
}
