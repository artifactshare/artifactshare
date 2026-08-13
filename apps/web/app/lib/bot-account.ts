// Shared bot-account primitives: the reserved email domain, display-name
// normalization, and the bot token prefix. Server code, routes, and tests all
// use these helpers so validation cannot drift between layers.

/** Prefix for one-time bot tokens (parallel to asr_/ass_/ast_). */
export const BOT_TOKEN_PREFIX = 'asb_'

/**
 * Reserved (RFC 2606 `.invalid`) domain for generated bot addresses. The
 * domain is unobtainable, so nobody can register the address at a mail
 * provider and impersonate a bot. Sign-in and sign-up reject the whole
 * `.invalid` TLD so a human cannot pre-claim a future bot address either
 * (users.email is UNIQUE; a pre-claimed row would break bot creation).
 */
export const BOT_EMAIL_DOMAIN = 'bots.artifactshare.invalid'

/** True when the address (or any address) sits under the reserved TLD. */
export function isReservedBotEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain === 'invalid' || domain.endsWith('.invalid')
}

// Lowercase-only alphabet for the random local part. Grant matching compares
// emails lowercased; generating from a mixed-case alphabet could collapse two
// distinct ids into one address and trip the users.email UNIQUE constraint.
const BOT_EMAIL_LOCAL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const BOT_EMAIL_LOCAL_LENGTH = 20

export function generateBotEmail(
  randomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = randomValues(new Uint8Array(BOT_EMAIL_LOCAL_LENGTH))
  let local = ''
  for (const byte of bytes) {
    local += BOT_EMAIL_LOCAL_ALPHABET[byte % BOT_EMAIL_LOCAL_ALPHABET.length]
  }
  return `bot-${local}@${BOT_EMAIL_DOMAIN}`
}

export const BOT_NAME_MIN_LENGTH = 1
export const BOT_NAME_MAX_LENGTH = 30

// Unicode General Category Cc (control) and Cf (format / zero-width).
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}]/u

/**
 * Normalize a bot display name: trim, NFC. Returns null when invalid (empty,
 * longer than 30 code points after NFC, or containing control/format
 * characters). The stored value, validation, and tests all go through this
 * single helper; uniqueness is exact match on the stored value.
 */
export function normalizeBotDisplayName(input: string): string | null {
  const normalized = input.trim().normalize('NFC')
  const length = [...normalized].length
  if (length < BOT_NAME_MIN_LENGTH || length > BOT_NAME_MAX_LENGTH) return null
  if (FORBIDDEN_NAME_CHARS.test(normalized)) return null
  return normalized
}

export function isBotToken(token: string): boolean {
  return token.startsWith(BOT_TOKEN_PREFIX)
}
