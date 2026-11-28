import { describe, expect, test } from 'vitest'
import {
  canUseExternalPosting,
  canUseLinkSharing,
  linkExpiryStartingColumns,
  LINK_SHARING_PLAN_DEFAULTS,
  resolveLinkExpiry,
  validateLinkExpiryPolicy,
} from './link-sharing-policy'

const NOW = '2026-07-20T00:00:00.000Z'

describe('link sharing policy domain', () => {
  test('provides the plan defaults and gates Free external posting even when stored flags are true', () => {
    const free = {
      plan: 'free' as const,
      ...LINK_SHARING_PLAN_DEFAULTS.free,
      linkSharingEnabled: true,
      externalPostingEnabled: true,
    }
    expect(canUseLinkSharing(free)).toBe(true)
    expect(canUseExternalPosting(free)).toBe(false)
    expect(LINK_SHARING_PLAN_DEFAULTS.free).toMatchObject({
      linkSharingEnabled: true,
      externalPostingEnabled: false,
    })
    expect(LINK_SHARING_PLAN_DEFAULTS.plus).toMatchObject({
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: null,
    })
    expect(LINK_SHARING_PLAN_DEFAULTS.team).toMatchObject({
      linkSharingEnabled: false,
      externalPostingEnabled: true,
    })
    const plusWithCarriedTeamPolicy = {
      plan: 'plus' as const,
      ...LINK_SHARING_PLAN_DEFAULTS.plus,
      linkSharingEnabled: false,
      externalPostingEnabled: false,
    }
    expect(canUseLinkSharing(plusWithCarriedTeamPolicy)).toBe(false)
    expect(canUseExternalPosting(plusWithCarriedTeamPolicy)).toBe(false)
  })

  test('validates finite and unlimited expiry relationships', () => {
    expect(
      validateLinkExpiryPolicy({
        linkExpiryDefaultDays: 30,
        linkExpiryMaxDays: 90,
      }),
    ).toEqual({ kind: 'ok' })
    expect(
      validateLinkExpiryPolicy({
        linkExpiryDefaultDays: null,
        linkExpiryMaxDays: 90,
      }),
    ).toEqual({ kind: 'invalid', field: 'relationship' })
    for (const value of [0, 366, -1, 1.5]) {
      expect(
        validateLinkExpiryPolicy({
          linkExpiryDefaultDays: value,
          linkExpiryMaxDays: 365,
        }),
      ).toEqual({ kind: 'invalid', field: 'default' })
    }
    expect(
      validateLinkExpiryPolicy({
        linkExpiryDefaultDays: 91,
        linkExpiryMaxDays: 90,
      }),
    ).toEqual({ kind: 'invalid', field: 'relationship' })
  })

  test('resolves default, explicit, and unlimited UTC expiry', () => {
    // A workspace that set a 90-day maximum; the starting policy has none.
    const policy = {
      plan: 'plus' as const,
      ...LINK_SHARING_PLAN_DEFAULTS.plus,
      linkExpiryMaxDays: 90,
    }
    expect(resolveLinkExpiry(policy, undefined, NOW)).toEqual({
      kind: 'ok',
      linkExpiresAt: '2026-08-19T00:00:00.000Z',
    })
    expect(resolveLinkExpiry(policy, '2026-08-01T12:00:00.000Z', NOW)).toEqual({
      kind: 'ok',
      linkExpiresAt: '2026-08-01T12:00:00.000Z',
    })
    expect(resolveLinkExpiry(policy, '2026-07-20T00:00:00Z', NOW)).toEqual({
      kind: 'invalid',
      reason: 'past',
    })
    expect(
      resolveLinkExpiry({ ...policy, linkExpiryMaxDays: null }, null, NOW),
    ).toEqual({
      kind: 'ok',
      linkExpiresAt: null,
    })
    expect(resolveLinkExpiry(policy, null, NOW)).toEqual({
      kind: 'invalid',
      reason: 'unlimited',
    })
  })

  test('workspace inserts carry the starting expiry columns explicitly', () => {
    expect(linkExpiryStartingColumns()).toEqual({
      link_expiry_default_days: 30,
      link_expiry_max_days: null,
    })
  })

  test('every plan starts at a 30-day default with no maximum', () => {
    for (const plan of ['free', 'plus', 'team'] as const)
      expect(LINK_SHARING_PLAN_DEFAULTS[plan]).toMatchObject({
        linkExpiryDefaultDays: 30,
        linkExpiryMaxDays: null,
      })
  })
})
