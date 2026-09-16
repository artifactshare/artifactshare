import { describe, expect, test, vi } from 'vitest'

import {
  assertFlagshipRegistrationIsCurrent,
  evaluateFlagshipFlag,
  evaluateFlagshipMode,
  type FlagshipFlagRegistration,
} from './flagship-fallback.server'

const FLAG_KEY = 'test-flag'
const CONTEXT = { targetingKey: 'ws1', workspaceId: 'ws1' }
const TEST_MODE_FLAG = {
  flagKey: 'test-mode',
  modes: ['off', 'shadow', 'canary', 'on'],
  defaultMode: 'off',
} as const

describe('evaluateFlagshipFlag', () => {
  test('production fail-closed when binding is missing', async () => {
    const result = await evaluateFlagshipFlag(
      { APP_ENV: 'production' },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: true,
      enabled: false,
    })
  })

  test('production ignores DEV_FLAGS when binding is missing', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'production',
        DEV_FLAGS: FLAG_KEY,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: true,
      enabled: false,
    })
  })

  test('non-production disabled when binding is missing and DEV_FLAGS is unset', async () => {
    const result = await evaluateFlagshipFlag(
      { APP_ENV: 'development' },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: false,
    })
  })

  test('non-production enabled when binding is missing and nonProductionDefault is true', async () => {
    const result = await evaluateFlagshipFlag(
      { APP_ENV: 'development' },
      { flagKey: FLAG_KEY, context: CONTEXT, nonProductionDefault: true },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: true,
    })
  })

  test('non-production enabled when DEV_FLAGS lists the flag alone', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: FLAG_KEY,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: true,
    })
  })

  test('non-production enabled when DEV_FLAGS entry has surrounding whitespace', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: ` ${FLAG_KEY} `,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: true,
    })
  })

  test('non-production enabled when DEV_FLAGS lists the flag among others', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: `maintenance, ${FLAG_KEY}, unrelated-flag`,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: true,
    })
  })

  test('non-production disabled when DEV_FLAGS lists only unrelated keys', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: 'maintenance, unrelated-flag',
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: false,
    })
  })

  test('preserves bare boolean keys alongside string mode entries', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: `test-mode=on, ${FLAG_KEY}`,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: true,
    })
  })

  test('does not treat a key=mode entry as a bare boolean key', async () => {
    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: `${FLAG_KEY}=on`,
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: false,
    })
  })

  test('treats missing APP_ENV as non-production when binding is missing', async () => {
    const result = await evaluateFlagshipFlag(
      {},
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      enabled: false,
    })
  })

  test('evaluates via getBooleanValue when binding is present', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)

    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'development',
        DEV_FLAGS: FLAG_KEY,
        FLAGS: { getBooleanValue },
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(getBooleanValue).toHaveBeenCalledWith(FLAG_KEY, false, CONTEXT)
    expect(result).toEqual({ kind: 'evaluated', enabled: true })
  })

  test('returns evaluation-error when getBooleanValue throws', async () => {
    const error = new Error('flag error')
    const getBooleanValue = vi.fn().mockRejectedValue(error)

    const result = await evaluateFlagshipFlag(
      {
        APP_ENV: 'production',
        FLAGS: { getBooleanValue },
      },
      { flagKey: FLAG_KEY, context: CONTEXT },
    )

    expect(result).toEqual({ kind: 'evaluation-error', error })
  })
})

describe('evaluateFlagshipMode', () => {
  test('production fails closed when the binding is missing', async () => {
    const result = await evaluateFlagshipMode(
      {
        APP_ENV: 'production',
        DEV_FLAGS: 'test-mode=on',
      },
      { ...TEST_MODE_FLAG, context: CONTEXT },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: true,
      mode: 'off',
    })
  })

  test.each(['off', 'shadow', 'canary', 'on'] as const)(
    'reads the %s mode from DEV_FLAGS when the binding is missing outside production',
    async (mode) => {
      const result = await evaluateFlagshipMode(
        {
          APP_ENV: 'development',
          DEV_FLAGS: `maintenance, test-mode = ${mode}, bot-members`,
        },
        { ...TEST_MODE_FLAG, context: CONTEXT },
      )

      expect(result).toEqual({
        kind: 'missing-binding',
        production: false,
        mode,
      })
    },
  )

  test.each([
    'test-mode',
    'test-mode=',
    'test-mode=unexpected',
    'unrelated=on',
  ])(
    'uses the safe default for an invalid DEV_FLAGS entry: %s',
    async (entry) => {
      const result = await evaluateFlagshipMode(
        { APP_ENV: 'development', DEV_FLAGS: entry },
        { ...TEST_MODE_FLAG, context: CONTEXT },
      )

      expect(result).toEqual({
        kind: 'missing-binding',
        production: false,
        mode: 'off',
      })
    },
  )

  test('lets a caller choose a non-production default', async () => {
    const result = await evaluateFlagshipMode(
      { APP_ENV: 'development' },
      {
        ...TEST_MODE_FLAG,
        context: CONTEXT,
        nonProductionDefault: 'shadow',
      },
    )

    expect(result).toEqual({
      kind: 'missing-binding',
      production: false,
      mode: 'shadow',
    })
  })

  test('evaluates a registered mode through the binding', async () => {
    const getStringValue = vi.fn().mockResolvedValue('canary')

    const result = await evaluateFlagshipMode(
      {
        APP_ENV: 'development',
        DEV_FLAGS: 'test-mode=on',
        FLAGS: { getStringValue },
      },
      { ...TEST_MODE_FLAG, context: CONTEXT },
    )

    expect(getStringValue).toHaveBeenCalledWith('test-mode', 'off', CONTEXT)
    expect(result).toEqual({ kind: 'evaluated', mode: 'canary' })
  })

  test('fails closed but distinguishes an invalid binding value', async () => {
    const result = await evaluateFlagshipMode(
      { FLAGS: { getStringValue: vi.fn().mockResolvedValue('unexpected') } },
      { ...TEST_MODE_FLAG, context: CONTEXT },
    )

    expect(result).toMatchObject({ kind: 'evaluation-error', mode: 'off' })
    expect(result.kind === 'evaluation-error' && result.error).toBeInstanceOf(
      Error,
    )
  })

  test('fails closed but preserves a binding evaluation error', async () => {
    const error = new Error('flag error')
    const result = await evaluateFlagshipMode(
      { FLAGS: { getStringValue: vi.fn().mockRejectedValue(error) } },
      { ...TEST_MODE_FLAG, context: CONTEXT },
    )

    expect(result).toEqual({ kind: 'evaluation-error', error, mode: 'off' })
  })
})

describe('Flagship registration expiry', () => {
  const registration = {
    flagKey: 'test-string-flag',
    modes: ['off', 'on'],
    defaultMode: 'off',
    expiresOn: '2026-09-30',
  } as const satisfies FlagshipFlagRegistration

  test('accepts a canonical future or current UTC date', () => {
    expect(() =>
      assertFlagshipRegistrationIsCurrent(
        registration,
        new Date('2026-09-30T23:59:59.999Z'),
      ),
    ).not.toThrow()
  })

  test('rejects an expired registration', () => {
    expect(() =>
      assertFlagshipRegistrationIsCurrent(
        registration,
        new Date('2026-10-01T00:00:00.000Z'),
      ),
    ).toThrow('Flagship flag test-string-flag has expired')
  })

  test.each(['2026-9-30', '2026-02-30'])(
    'rejects invalid registration date %s',
    (expiresOn) => {
      expect(() =>
        assertFlagshipRegistrationIsCurrent({
          ...registration,
          expiresOn: expiresOn as `${number}-${number}-${number}`,
        }),
      ).toThrow('Flagship flag test-string-flag has an invalid expiry date')
    },
  )
})
