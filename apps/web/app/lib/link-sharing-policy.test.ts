import { describe, expect, test } from 'vitest'
import {
  canUseExternalPosting,
  canUseLinkSharing,
  linkSharingPolicyDefaults,
  resolveLinkExpiry,
  validateLinkExpiryPolicy,
} from './link-sharing-policy'

const NOW = '2026-07-20T00:00:00.000Z'

describe('link sharing policy domain', () => {
  test('provides the plan defaults and gates Free even when stored flags are true', () => {
    const free = {
      ...linkSharingPolicyDefaults('free'),
      linkSharingEnabled: true,
      externalPostingEnabled: true,
    }
    expect(canUseLinkSharing(free)).toBe(false)
    expect(canUseExternalPosting(free)).toBe(false)
    expect(linkSharingPolicyDefaults('plus')).toMatchObject({
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 90,
    })
    expect(linkSharingPolicyDefaults('team')).toMatchObject({
      linkSharingEnabled: false,
      externalPostingEnabled: true,
    })
    const plusWithCarriedTeamPolicy = {
      ...linkSharingPolicyDefaults('plus'),
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
    const policy = linkSharingPolicyDefaults('plus')
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
})
