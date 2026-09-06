import { describe, expect, test } from 'vitest'
import {
  DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
  DEFAULT_LINK_LOW_TRUST_LINK_PUBLISH_COUNT,
  isLowTrustLinkWorkspace,
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
