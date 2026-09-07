import { describe, expect, test } from 'vitest'
import {
  DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
  DEFAULT_LINK_LOW_TRUST_LINK_PUBLISH_COUNT,
  DEFAULT_LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT,
  isLinkPublishLimitedWorkspace,
  isLinkPublishRateLimited,
  isLowTrustLinkWorkspace,
  linkPublishRateLimitFromEnv,
  linkTrustThresholdsFromEnv,
} from './link-trust-policy'

const thresholds = {
  accountAgeDays: DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
  linkPublishCount: DEFAULT_LINK_LOW_TRUST_LINK_PUBLISH_COUNT,
}

function lowTrust(
  overrides: Partial<Parameters<typeof isLowTrustLinkWorkspace>[0]> = {},
) {
  return isLowTrustLinkWorkspace({
    plan: 'free',
    ownerCreatedAt: '2026-08-01T00:00:00.000Z',
    now: '2026-09-01T00:00:00.000Z',
    linkPublishCount: 5,
    thresholds,
    ...overrides,
  })
}

describe('link trust policy', () => {
  test('uses the documented defaults and ignores invalid overrides', () => {
    expect(linkTrustThresholdsFromEnv({})).toEqual(thresholds)
    expect(
      linkTrustThresholdsFromEnv({
        LINK_LOW_TRUST_ACCOUNT_AGE_DAYS: '-1',
        LINK_LOW_TRUST_LINK_PUBLISH_COUNT: 'five',
      }),
    ).toEqual(thresholds)
  })

  test('accepts non-negative integer threshold overrides', () => {
    expect(
      linkTrustThresholdsFromEnv({
        LINK_LOW_TRUST_ACCOUNT_AGE_DAYS: '30',
        LINK_LOW_TRUST_LINK_PUBLISH_COUNT: '8',
      }),
    ).toEqual({ accountAgeDays: 30, linkPublishCount: 8 })
  })

  test('marks a free workspace low trust below either strict threshold', () => {
    expect(lowTrust({ ownerCreatedAt: '2026-08-20T00:00:00.000Z' })).toBe(true)
    expect(lowTrust({ linkPublishCount: 4 })).toBe(true)
  })

  test('does not mark a free workspace low trust at both thresholds', () => {
    expect(
      lowTrust({
        ownerCreatedAt: '2026-08-18T00:00:00.000Z',
        now: '2026-09-01T00:00:00.000Z',
        linkPublishCount: 5,
      }),
    ).toBe(false)
  })

  test.each(['plus', 'team'])(
    'exempts the paid %s plan regardless of age and publish count',
    (plan) => {
      expect(
        lowTrust({
          plan,
          ownerCreatedAt: '2026-09-01T00:00:00.000Z',
          linkPublishCount: 0,
        }),
      ).toBe(false)
    },
  )

  test('fails safe for malformed free-account dates', () => {
    expect(lowTrust({ ownerCreatedAt: 'not-a-date' })).toBe(true)
  })
})

describe('new-account link publish rate limit', () => {
  const limit = {
    accountAgeDays: DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
    dailyLimit: DEFAULT_LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT,
  }
  function limited(
    overrides: Partial<Parameters<typeof isLinkPublishRateLimited>[0]> = {},
  ) {
    return isLinkPublishRateLimited({
      plan: 'free',
      workspaceCreatedAt: '2026-08-25T00:00:00.000Z',
      now: '2026-09-01T00:00:00.000Z',
      publishedInWindow: 20,
      limit,
      ...overrides,
    })
  }

  test('shares the account age threshold and reads its own daily limit', () => {
    expect(linkPublishRateLimitFromEnv({})).toEqual(limit)
    expect(
      linkPublishRateLimitFromEnv({
        LINK_LOW_TRUST_ACCOUNT_AGE_DAYS: '3',
        LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT: '7',
      }),
    ).toEqual({ accountAgeDays: 3, dailyLimit: 7 })
    expect(
      linkPublishRateLimitFromEnv({
        LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT: '-1',
      }).dailyLimit,
    ).toBe(DEFAULT_LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT)
  })

  test('limits a new free workspace once it reaches the daily count', () => {
    expect(limited()).toBe(true)
    expect(limited({ publishedInWindow: 19 })).toBe(false)
  })

  test('does not limit an established workspace or a paid plan', () => {
    expect(limited({ workspaceCreatedAt: '2026-08-01T00:00:00.000Z' })).toBe(
      false,
    )
    expect(limited({ plan: 'plus' })).toBe(false)
    expect(limited({ plan: 'team' })).toBe(false)
  })

  test('the workspace predicate ignores the count', () => {
    const base = {
      plan: 'free',
      workspaceCreatedAt: '2026-08-25T00:00:00.000Z',
      now: '2026-09-01T00:00:00.000Z',
      limit,
    }
    expect(isLinkPublishLimitedWorkspace(base)).toBe(true)
    expect(
      isLinkPublishLimitedWorkspace({
        ...base,
        workspaceCreatedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toBe(false)
    expect(isLinkPublishLimitedWorkspace({ ...base, plan: 'team' })).toBe(false)
  })

  test('a zero limit disables the rule; a malformed date counts as new', () => {
    expect(limited({ limit: { ...limit, dailyLimit: 0 } })).toBe(false)
    expect(limited({ workspaceCreatedAt: 'not-a-date' })).toBe(true)
  })
})
