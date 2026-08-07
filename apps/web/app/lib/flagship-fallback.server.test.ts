import { describe, expect, test, vi } from 'vitest'

import { evaluateFlagshipFlag } from './flagship-fallback.server'

const FLAG_KEY = 'test-flag'
const CONTEXT = { targetingKey: 'ws1', workspaceId: 'ws1' }

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
        DEV_FLAGS: `maintenance, ${FLAG_KEY}, upload-allowed`,
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
        DEV_FLAGS: 'maintenance, upload-allowed',
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
