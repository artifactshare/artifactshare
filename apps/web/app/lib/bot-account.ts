export const BOT_TOKEN_PREFIX = 'asb_'

/**
 * Reserved (RFC 2606 `.invalid`) domain for generated bot addresses. The
 * domain is unobtainable, so nobody can register the address at a mail
 * provider and impersonate a bot.
 */
export const BOT_EMAIL_DOMAIN = 'bots.artifactshare.invalid'

export function isBotEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() === BOT_EMAIL_DOMAIN
  )
}

export function isReservedBotEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return domain === 'invalid' || domain.endsWith('.invalid')
}

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

const BOT_NAME_MIN_LENGTH = 1
const BOT_NAME_MAX_LENGTH = 30

const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}]/u

export function normalizeBotDisplayName(input: string): string | null {
  const normalized = input.trim().normalize('NFC')
  const length = [...normalized].length
  if (length < BOT_NAME_MIN_LENGTH || length > BOT_NAME_MAX_LENGTH) return null
  if (FORBIDDEN_NAME_CHARS.test(normalized)) return null
  return normalized
}
