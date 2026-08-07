import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { encodeBase64Url } from '~/lib/base64url'
import { nowIso } from '~/lib/datetime'
import { computeTextSha256Hex } from '~/lib/sha256'
import type { DB } from '~/types/db'

const REFRESH_TOKEN_PREFIX = 'asr_'
const SESSION_TOKEN_PREFIX = 'ass_'
const TOKEN_RANDOM_BYTES = 32
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000
const SESSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type IssuedCliRefreshCredential = {
  refreshToken: string
  expiresAt: string
}

export type RefreshedCliSession =
  | {
      kind: 'ok'
      sessionToken: string
      expiresAt: string
    }
  | { kind: 'invalid' }

export async function issueCliRefreshCredential(
  db: Kysely<DB>,
  userId: string,
): Promise<IssuedCliRefreshCredential> {
  const refreshToken = generateToken(REFRESH_TOKEN_PREFIX)
  const tokenHash = await hashToken(refreshToken)
  const now = nowIso()
  const expiresAt = isoMsFromNow(REFRESH_TOKEN_TTL_MS)

  await db
    .insertInto('cli_refresh_credentials')
    .values({
      id: nanoid(),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: now,
      last_used_at: null,
    })
    .execute()

  return { refreshToken, expiresAt }
}

export async function refreshCliSession(
  db: Kysely<DB>,
  refreshToken: string,
): Promise<RefreshedCliSession> {
  const tokenHash = await hashToken(refreshToken)
  const now = nowIso()
  const row = await db
    .selectFrom('cli_refresh_credentials')
    .innerJoin('users', 'users.id', 'cli_refresh_credentials.user_id')
    .select(['cli_refresh_credentials.id', 'cli_refresh_credentials.user_id'])
    .where('cli_refresh_credentials.token_hash', '=', tokenHash)
    .where('cli_refresh_credentials.expires_at', '>', now)
    .where('cli_refresh_credentials.revoked_at', 'is', null)
    .executeTakeFirst()

  if (!row) return { kind: 'invalid' }

  const sessionToken = generateToken(SESSION_TOKEN_PREFIX)
  const expiresAt = isoMsFromNow(SESSION_TOKEN_TTL_MS)

  await db
    .updateTable('cli_refresh_credentials')
    .set({ last_used_at: now })
    .where('id', '=', row.id)
    .execute()

  await db
    .insertInto('sessions')
    .values({
      id: nanoid(),
      user_id: row.user_id,
      token: sessionToken,
      expires_at: expiresAt,
      ip_address: null,
      user_agent: null,
      created_at: now,
      updated_at: now,
    })
    .execute()

  return { kind: 'ok', sessionToken, expiresAt }
}

export function isCliRefreshedSessionToken(token: string): boolean {
  return token.startsWith(SESSION_TOKEN_PREFIX)
}

function generateToken(prefix: string): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return prefix + encodeBase64Url(bytes)
}

function hashToken(token: string): Promise<string> {
  return computeTextSha256Hex(token)
}

function isoMsFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}
