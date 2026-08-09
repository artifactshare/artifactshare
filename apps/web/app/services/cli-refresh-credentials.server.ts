import { sql, type ExpressionBuilder, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { encodeBase64Url } from '~/lib/base64url'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { hmacSha256Base64Url } from '~/lib/hmac'
import { computeTextSha256Hex } from '~/lib/sha256'
import type { DB } from '~/types/db'

const REFRESH_TOKEN_PREFIX = 'asr_'
const SESSION_TOKEN_PREFIX = 'ass_'
const TOKEN_RANDOM_BYTES = 32
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000
const SESSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ROTATION_RETRY_TTL_MS = 10 * 60 * 1000
// A linkage marker for CLI-family cleanup, not proof of a distinct authority.
export const CLI_DEVICE_SESSION_USER_AGENT = 'artifactshare-cli-device'

export type IssuedCliRefreshCredential = {
  refreshToken: string
  expiresAt: string
}

export type RefreshedCliSession =
  | {
      kind: 'ok'
      sessionToken: string
      sessionExpiresAt: string
      refreshToken: string
      refreshExpiresAt: string
    }
  | { kind: 'invalid' }

export async function cleanupExpiredCliRotationReplays(
  db: Kysely<DB>,
  now: string = nowIso(),
): Promise<number> {
  const result = await db
    .updateTable('cli_refresh_credentials')
    .set({
      rotation_request_hash: null,
      rotation_retry_until: null,
      rotation_session_id: null,
    })
    .where('rotation_retry_until', '<=', now)
    .where('rotation_request_hash', 'is not', null)
    .where('rotation_session_id', 'is not', null)
    .where('replaced_by_id', 'is not', null)
    .where('revoked_at', 'is not', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows)
}

export function issueCliRefreshCredential(
  db: Kysely<DB>,
  userId: string,
): Promise<IssuedCliRefreshCredential>
export function issueCliRefreshCredential(
  db: Kysely<DB>,
  userId: string,
  sourceSessionToken: string,
): Promise<IssuedCliRefreshCredential | null>
export async function issueCliRefreshCredential(
  db: Kysely<DB>,
  userId: string,
  sourceSessionToken?: string,
): Promise<IssuedCliRefreshCredential | null> {
  const id = nanoid()
  const refreshToken = generateToken(REFRESH_TOKEN_PREFIX)
  const tokenHash = await hashToken(refreshToken)
  const now = nowIso()
  const expiresAt = isoMsFromNow(REFRESH_TOKEN_TTL_MS)
  const credentialValues = {
    id,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    revoked_at: null,
    created_at: now,
    last_used_at: null,
    family_id: id,
    replaced_by_id: null,
    rotation_request_hash: null,
    rotation_retry_until: null,
    rotation_session_id: null,
  }
  const credential = sourceSessionToken
    ? db
        .insertInto('cli_refresh_credentials')
        .columns(
          Object.keys(credentialValues) as (keyof typeof credentialValues)[],
        )
        .expression((eb) =>
          verifiedCliDeviceSession(eb, sourceSessionToken, userId).select(
            Object.entries(credentialValues).map(([column, value]) =>
              eb.val(value).as(column),
            ),
          ),
        )
    : db.insertInto('cli_refresh_credentials').values(credentialValues)
  const audit = auditInsert(db, {
    id: nanoid(),
    userId,
    action: 'cli.refresh_credential.issue',
    credentialId: id,
    detail: { credential_kind: 'cli_refresh', family_id: id },
    createdAt: now,
    guardActiveCredentialId: id,
  })
  const sessionLink = sourceSessionToken
    ? db
        .insertInto('cli_refresh_sessions')
        .columns(['session_id', 'credential_id', 'family_id'])
        .expression((eb) =>
          verifiedCliDeviceSession(eb, sourceSessionToken, userId).select([
            'sessions.id as session_id',
            eb.val(id).as('credential_id'),
            eb.val(id).as('family_id'),
          ]),
        )
    : null
  const supersedePriorCredentials = sourceSessionToken
    ? db
        .updateTable('cli_refresh_credentials')
        .set({ revoked_at: now })
        .where('revoked_at', 'is', null)
        .where(
          'family_id',
          'in',
          db
            .selectFrom('cli_refresh_sessions')
            .innerJoin(
              'sessions',
              'sessions.id',
              'cli_refresh_sessions.session_id',
            )
            .select('cli_refresh_sessions.family_id')
            .where('sessions.token', '=', sourceSessionToken)
            .where('sessions.user_id', '=', userId)
            .where('sessions.user_agent', '=', CLI_DEVICE_SESSION_USER_AGENT),
        )
    : null
  await runD1Batch(
    ...(supersedePriorCredentials ? [supersedePriorCredentials] : []),
    credential,
    ...(sessionLink ? [sessionLink] : []),
    audit,
  )

  if (sourceSessionToken) {
    const committed = await db
      .selectFrom('cli_refresh_credentials')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!committed) return null
  }

  return { refreshToken, expiresAt }
}

function verifiedCliDeviceSession<TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  token: string,
  userId: string,
) {
  return eb
    .selectFrom('sessions')
    .where(sql<boolean>`sessions.token = ${token}`)
    .where(sql<boolean>`sessions.user_id = ${userId}`)
    .where(sql<boolean>`sessions.user_agent = ${CLI_DEVICE_SESSION_USER_AGENT}`)
}

export async function refreshCliSession(
  db: Kysely<DB>,
  refreshToken: string,
  rotationRequestId: string | null,
  hmacSecret: string,
): Promise<RefreshedCliSession> {
  if (rotationRequestId === null) {
    return await refreshLegacyCliSession(db, refreshToken)
  }
  const [tokenHash, requestHash] = await Promise.all([
    hashToken(refreshToken),
    hashToken(rotationRequestId),
  ])
  const now = nowIso()
  const current = await db
    .selectFrom('cli_refresh_credentials')
    .innerJoin('users', 'users.id', 'cli_refresh_credentials.user_id')
    .select([
      'cli_refresh_credentials.id',
      'cli_refresh_credentials.user_id',
      'cli_refresh_credentials.family_id',
      'cli_refresh_credentials.expires_at',
      'cli_refresh_credentials.revoked_at',
    ])
    .where('cli_refresh_credentials.token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (!current) return { kind: 'invalid' }
  if (current.family_id === null) return { kind: 'invalid' }
  if (current.revoked_at !== null) {
    return await readRotationReplay(db, tokenHash, requestHash, now, hmacSecret)
  }
  if (current.expires_at <= now) return { kind: 'invalid' }

  const replacementId = nanoid()
  const sessionId = nanoid()
  const familyId = current.family_id
  const retryUntil = isoMsFromNow(ROTATION_RETRY_TTL_MS)
  const refreshExpiresAt = isoMsFromNow(REFRESH_TOKEN_TTL_MS)
  const sessionExpiresAt = isoMsFromNow(SESSION_TOKEN_TTL_MS)
  const nextRefreshToken = await deriveRotatedToken(
    hmacSecret,
    current.id,
    rotationRequestId,
    refreshToken,
  )
  const nextRefreshHash = await hashToken(nextRefreshToken)
  const sessionToken = generateToken(SESSION_TOKEN_PREFIX)

  const rotate = db
    .updateTable('cli_refresh_credentials')
    .set({
      revoked_at: now,
      last_used_at: now,
      replaced_by_id: replacementId,
      rotation_request_hash: requestHash,
      rotation_retry_until: retryUntil,
      rotation_session_id: sessionId,
    })
    .where('id', '=', current.id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)

  const replacement = db
    .insertInto('cli_refresh_credentials')
    .columns([
      'id',
      'user_id',
      'token_hash',
      'expires_at',
      'revoked_at',
      'created_at',
      'last_used_at',
      'family_id',
      'replaced_by_id',
      'rotation_request_hash',
      'rotation_retry_until',
      'rotation_session_id',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_refresh_credentials')
        .where('id', '=', current.id)
        .where('replaced_by_id', '=', replacementId)
        .where('rotation_request_hash', '=', requestHash)
        .select([
          eb.val(replacementId).as('id'),
          eb.val(current.user_id).as('user_id'),
          eb.val(nextRefreshHash).as('token_hash'),
          eb.val(refreshExpiresAt).as('expires_at'),
          eb.val(null).as('revoked_at'),
          eb.val(now).as('created_at'),
          eb.val(null).as('last_used_at'),
          eb.val(familyId).as('family_id'),
          eb.val(null).as('replaced_by_id'),
          eb.val(null).as('rotation_request_hash'),
          eb.val(null).as('rotation_retry_until'),
          eb.val(null).as('rotation_session_id'),
        ]),
    )

  const session = db
    .insertInto('sessions')
    .columns([
      'id',
      'user_id',
      'token',
      'expires_at',
      'ip_address',
      'user_agent',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_refresh_credentials')
        .where('id', '=', current.id)
        .where('replaced_by_id', '=', replacementId)
        .where('rotation_request_hash', '=', requestHash)
        .select([
          eb.val(sessionId).as('id'),
          eb.val(current.user_id).as('user_id'),
          eb.val(sessionToken).as('token'),
          eb.val(sessionExpiresAt).as('expires_at'),
          eb.val(null).as('ip_address'),
          eb.val(null).as('user_agent'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )

  const sessionLink = db
    .insertInto('cli_refresh_sessions')
    .columns(['session_id', 'credential_id', 'family_id'])
    .expression((eb) =>
      eb
        .selectFrom('cli_refresh_credentials')
        .where('id', '=', replacementId)
        .select([
          eb.val(sessionId).as('session_id'),
          eb.val(replacementId).as('credential_id'),
          eb.val(familyId).as('family_id'),
        ]),
    )

  const audit = auditInsert(db, {
    id: nanoid(),
    userId: current.user_id,
    action: 'cli.refresh_credential.rotate',
    credentialId: replacementId,
    detail: {
      credential_kind: 'cli_refresh',
      family_id: familyId,
      previous_credential_id: current.id,
    },
    createdAt: now,
    guardCredentialId: current.id,
    guardReplacementId: replacementId,
    guardRequestHash: requestHash,
  })

  await runD1Batch(rotate, replacement, session, sessionLink, audit)
  return await readRotationReplay(db, tokenHash, requestHash, now, hmacSecret)
}

async function refreshLegacyCliSession(
  db: Kysely<DB>,
  refreshToken: string,
): Promise<RefreshedCliSession> {
  const tokenHash = await hashToken(refreshToken)
  const now = nowIso()
  const row = await db
    .selectFrom('cli_refresh_credentials')
    .innerJoin('users', 'users.id', 'cli_refresh_credentials.user_id')
    .select([
      'cli_refresh_credentials.id',
      'cli_refresh_credentials.user_id',
      'cli_refresh_credentials.family_id',
      'cli_refresh_credentials.expires_at',
    ])
    .where('cli_refresh_credentials.token_hash', '=', tokenHash)
    .where('cli_refresh_credentials.expires_at', '>', now)
    .where('cli_refresh_credentials.revoked_at', 'is', null)
    .whereRef(
      'cli_refresh_credentials.id',
      '=',
      'cli_refresh_credentials.family_id',
    )
    .executeTakeFirst()
  if (!row || row.family_id === null) return { kind: 'invalid' }

  const sessionId = nanoid()
  const sessionToken = generateToken(SESSION_TOKEN_PREFIX)
  const sessionExpiresAt = isoMsFromNow(SESSION_TOKEN_TTL_MS)
  const used = db
    .updateTable('cli_refresh_credentials')
    .set({ last_used_at: now })
    .where('id', '=', row.id)
    .where('revoked_at', 'is', null)
  const session = db
    .insertInto('sessions')
    .columns([
      'id',
      'user_id',
      'token',
      'expires_at',
      'ip_address',
      'user_agent',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_refresh_credentials')
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .select([
          eb.val(sessionId).as('id'),
          eb.val(row.user_id).as('user_id'),
          eb.val(sessionToken).as('token'),
          eb.val(sessionExpiresAt).as('expires_at'),
          eb.val(null).as('ip_address'),
          eb.val(null).as('user_agent'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )
  const audit = auditInsert(db, {
    id: nanoid(),
    userId: row.user_id,
    action: 'cli.refresh_credential.use_legacy',
    credentialId: row.id,
    detail: {
      credential_kind: 'cli_refresh',
      family_id: row.family_id,
    },
    createdAt: now,
    guardActiveCredentialId: row.id,
  })
  const sessionLink = db
    .insertInto('cli_refresh_sessions')
    .columns(['session_id', 'credential_id', 'family_id'])
    .expression((eb) =>
      eb
        .selectFrom('sessions')
        .where('id', '=', sessionId)
        .select([
          eb.val(sessionId).as('session_id'),
          eb.val(row.id).as('credential_id'),
          eb.val(row.family_id).as('family_id'),
        ]),
    )
  await runD1Batch(audit, session, sessionLink, used)
  const committed = await db
    .selectFrom('sessions')
    .select('id')
    .where('id', '=', sessionId)
    .executeTakeFirst()
  if (!committed) return { kind: 'invalid' }
  return {
    kind: 'ok',
    sessionToken,
    sessionExpiresAt,
    refreshToken,
    refreshExpiresAt: row.expires_at,
  }
}

export async function revokeCliRefreshCredential(
  db: Kysely<DB>,
  refreshToken: string,
): Promise<'ok' | 'invalid' | 'inconsistent'> {
  const tokenHash = await hashToken(refreshToken)
  const row = await db
    .selectFrom('cli_refresh_credentials')
    .innerJoin('users', 'users.id', 'cli_refresh_credentials.user_id')
    .select([
      'cli_refresh_credentials.id',
      'cli_refresh_credentials.user_id',
      'cli_refresh_credentials.family_id',
    ])
    .where('cli_refresh_credentials.token_hash', '=', tokenHash)
    .executeTakeFirst()
  if (!row) return 'invalid'
  if (row.family_id === null) return 'inconsistent'

  const now = nowIso()
  const familyId = row.family_id
  const audit = auditInsert(db, {
    id: nanoid(),
    userId: row.user_id,
    action: 'cli.refresh_credential.revoke',
    credentialId: row.id,
    detail: { credential_kind: 'cli_refresh', family_id: familyId },
    createdAt: now,
    guardActiveFamilyId: familyId,
  })
  const revoke = db
    .updateTable('cli_refresh_credentials')
    .set({ revoked_at: now })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
  const revokeSessions = db
    .deleteFrom('sessions')
    .where(
      'id',
      'in',
      db
        .selectFrom('cli_refresh_sessions')
        .select('session_id')
        .where('family_id', '=', familyId),
    )
  // Sessions minted before cli_refresh_sessions existed cannot be attributed to
  // one family. Revoke only unlinked CLI sessions for this user; browser
  // sessions and sessions linked to another current family remain active.
  const revokePreLinkSessions = db
    .deleteFrom('sessions')
    .where('user_id', '=', row.user_id)
    .where(sql<boolean>`substr(token, 1, 4) = 'ass_'`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('cli_refresh_sessions')
            .select('session_id')
            .whereRef('session_id', '=', 'sessions.id'),
        ),
      ),
    )
  await runD1Batch(audit, revokeSessions, revokePreLinkSessions, revoke)
  return 'ok'
}

async function readRotationReplay(
  db: Kysely<DB>,
  oldTokenHash: string,
  requestHash: string,
  now: string,
  hmacSecret: string,
): Promise<RefreshedCliSession> {
  const row = await db
    .selectFrom('cli_refresh_credentials as old')
    .innerJoin(
      'cli_refresh_credentials as next',
      'next.id',
      'old.replaced_by_id',
    )
    .innerJoin('sessions', 'sessions.id', 'old.rotation_session_id')
    .select([
      'old.id as old_id',
      'next.expires_at as refresh_expires_at',
      'sessions.token as session_token',
      'sessions.expires_at as session_expires_at',
    ])
    .where('old.token_hash', '=', oldTokenHash)
    .where('old.rotation_request_hash', '=', requestHash)
    .where('old.rotation_retry_until', '>', now)
    .where('next.revoked_at', 'is', null)
    .executeTakeFirst()
  if (!row) return { kind: 'invalid' }
  return {
    kind: 'ok',
    sessionToken: row.session_token,
    sessionExpiresAt: row.session_expires_at,
    refreshToken: await deriveRotatedTokenFromHashes(
      hmacSecret,
      row.old_id,
      requestHash,
      oldTokenHash,
    ),
    refreshExpiresAt: row.refresh_expires_at,
  }
}

function auditInsert(
  db: Kysely<DB>,
  input: {
    id: string
    userId: string
    action: string
    credentialId: string
    detail: Record<string, string>
    createdAt: string
    guardCredentialId?: string
    guardReplacementId?: string
    guardRequestHash?: string
    guardActiveFamilyId?: string
    guardActiveCredentialId?: string
  },
) {
  let source = db.selectFrom('users').where('users.id', '=', input.userId)
  if (input.guardCredentialId) {
    source = source.where((eb) =>
      eb.exists(
        eb
          .selectFrom('cli_refresh_credentials')
          .select('id')
          .where('id', '=', input.guardCredentialId!)
          .where('replaced_by_id', '=', input.guardReplacementId!)
          .where('rotation_request_hash', '=', input.guardRequestHash!),
      ),
    )
  }
  if (input.guardActiveFamilyId) {
    source = source.where((eb) =>
      eb.exists(
        eb
          .selectFrom('cli_refresh_credentials')
          .select('id')
          .where('family_id', '=', input.guardActiveFamilyId!)
          .where('revoked_at', 'is', null),
      ),
    )
  }
  if (input.guardActiveCredentialId) {
    source = source.where((eb) =>
      eb.exists(
        eb
          .selectFrom('cli_refresh_credentials')
          .select('id')
          .where('id', '=', input.guardActiveCredentialId!)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', input.createdAt),
      ),
    )
  }
  return db
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
      source.select([
        eb.val(input.id).as('id'),
        'users.workspace_id',
        eb.val(input.userId).as('actor_user_id'),
        eb.val(input.action).as('action'),
        eb.val('cli_refresh_credential').as('subject_type'),
        eb.val(input.credentialId).as('subject_id'),
        eb.val(JSON.stringify(input.detail)).as('detail'),
        eb.val(input.createdAt).as('created_at'),
      ]),
    )
}

async function deriveRotatedToken(
  secret: string,
  credentialId: string,
  requestId: string,
  refreshToken: string,
): Promise<string> {
  const [requestHash, refreshTokenHash] = await Promise.all([
    hashToken(requestId),
    hashToken(refreshToken),
  ])
  return await deriveRotatedTokenFromHashes(
    secret,
    credentialId,
    requestHash,
    refreshTokenHash,
  )
}

async function deriveRotatedTokenFromHashes(
  secret: string,
  credentialId: string,
  requestHash: string,
  refreshTokenHash: string,
): Promise<string> {
  return (
    REFRESH_TOKEN_PREFIX +
    (await hmacSha256Base64Url(
      secret,
      `cli-refresh-rotation:${credentialId}:${requestHash}:${refreshTokenHash}`,
    ))
  )
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
