import { describe, expect, test } from 'vitest'
import {
  BOT_EMAIL_DOMAIN,
  generateBotEmail,
  isBotToken,
  isReservedBotEmailDomain,
  normalizeBotDisplayName,
} from './bot-account'

describe('normalizeBotDisplayName', () => {
  test('trims and NFC-normalizes', () => {
    expect(normalizeBotDisplayName('  Deploy bot ')).toBe('Deploy bot')
    // Combining ka + dakuten normalizes to precomposed ga.
    expect(normalizeBotDisplayName('が')).toBe('が')
  })

  test('length is counted in code points after NFC (1..30)', () => {
    expect(normalizeBotDisplayName('')).toBeNull()
    expect(normalizeBotDisplayName('   ')).toBeNull()
    expect(normalizeBotDisplayName('a'.repeat(30))).toBe('a'.repeat(30))
    expect(normalizeBotDisplayName('a'.repeat(31))).toBeNull()
    // Astral characters count as one code point.
    expect(normalizeBotDisplayName('😀'.repeat(30))).toBe('😀'.repeat(30))
  })

  test('rejects control (Cc) and format (Cf) characters', () => {
    expect(normalizeBotDisplayName('badname')).toBeNull()
    expect(normalizeBotDisplayName('bad\u200bname')).toBeNull()
    expect(normalizeBotDisplayName('bad\u200dname')).toBeNull()
  })

  test('case-differing names stay distinct values', () => {
    expect(normalizeBotDisplayName('Bot')).toBe('Bot')
    expect(normalizeBotDisplayName('bot')).toBe('bot')
  })
})

describe('generateBotEmail', () => {
  test('generates a lowercase local part under the reserved domain', () => {
    const email = generateBotEmail()
    expect(email.endsWith(`@${BOT_EMAIL_DOMAIN}`)).toBe(true)
    expect(email).toBe(email.toLowerCase())
    expect(email).toMatch(/^bot-[a-z0-9]{20}@/)
  })
})

describe('isReservedBotEmailDomain', () => {
  test('matches the whole .invalid TLD', () => {
    expect(isReservedBotEmailDomain('x@bots.artifactshare.invalid')).toBe(true)
    expect(isReservedBotEmailDomain('x@other.invalid')).toBe(true)
    expect(isReservedBotEmailDomain('x@invalid')).toBe(true)
    expect(isReservedBotEmailDomain('x@example.com')).toBe(false)
    expect(isReservedBotEmailDomain('x@invalid.test')).toBe(false)
    expect(isReservedBotEmailDomain('no-at-sign')).toBe(false)
  })
})

describe('isBotToken', () => {
  test('detects the asb_ prefix', () => {
    expect(isBotToken('asb_abc')).toBe(true)
    expect(isBotToken('asr_abc')).toBe(false)
    expect(isBotToken('ast_abc')).toBe(false)
  })
})
