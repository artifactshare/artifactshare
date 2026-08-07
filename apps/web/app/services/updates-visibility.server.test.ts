import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { UpdateEntry } from '~/lib/updates-types'
import {
  getVisibleUpdateBySlug,
  getVisibleUpdates,
  getLatestVisibleNotice,
  isUpdateEntryVisible,
  toDetail,
  toListItem,
} from './updates-visibility.server'

const evaluateFlagshipFlagMock = vi.hoisted(() => vi.fn())

vi.mock('~/lib/flagship-fallback.server', () => ({
  evaluateFlagshipFlag: evaluateFlagshipFlagMock,
}))

const getAllUpdatesMock = vi.hoisted(() => vi.fn())
const getUpdateBySlugMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/updates-content.server', () => ({
  getAllUpdates: getAllUpdatesMock,
  getUpdateBySlug: getUpdateBySlugMock,
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

const baseEntry: UpdateEntry = {
  slug: '2026-07-01-sample',
  title: 'Sample',
  date: '2026-07-01',
  products: ['web'],
  kind: 'new',
  bodyHtml: '<p>Body</p>',
  summaryHtml: '<p>Summary</p>',
  hasMore: false,
}

beforeEach(() => {
  evaluateFlagshipFlagMock.mockReset()
  getAllUpdatesMock.mockReset()
  getUpdateBySlugMock.mockReset()
})

describe('isUpdateEntryVisible', () => {
  test('shows entries without a flag regardless of evaluation', () => {
    expect(isUpdateEntryVisible(baseEntry, false)).toBe(true)
  })

  test('hides flagged entries when the flag is not enabled', () => {
    expect(
      isUpdateEntryVisible({ ...baseEntry, flag: 'beta-feature' }, false),
    ).toBe(false)
  })

  test('shows flagged entries only when enabled', () => {
    expect(
      isUpdateEntryVisible({ ...baseEntry, flag: 'beta-feature' }, true),
    ).toBe(true)
  })
})

describe('getVisibleUpdates', () => {
  test('filters flagged entries using evaluateFlagshipFlag', async () => {
    getAllUpdatesMock.mockReturnValue([
      baseEntry,
      { ...baseEntry, slug: 'hidden', flag: 'hidden-flag' },
      { ...baseEntry, slug: 'shown', flag: 'shown-flag' },
    ])
    evaluateFlagshipFlagMock.mockImplementation(
      async (_source: unknown, options: { flagKey: string }) => ({
        kind: 'evaluated',
        enabled: options.flagKey === 'shown-flag',
      }),
    )

    const visible = await getVisibleUpdates('en')
    expect(visible.map((entry) => entry.slug)).toEqual([
      '2026-07-01-sample',
      'shown',
    ])
  })

  test('hides flagged entries on missing binding and evaluation errors', async () => {
    getAllUpdatesMock.mockReturnValue([
      { ...baseEntry, slug: 'missing', flag: 'missing-flag' },
      { ...baseEntry, slug: 'error', flag: 'error-flag' },
    ])
    evaluateFlagshipFlagMock.mockImplementation(
      async (_source: unknown, options: { flagKey: string }) => {
        if (options.flagKey === 'missing-flag') {
          return { kind: 'missing-binding', production: true, enabled: false }
        }
        return { kind: 'evaluation-error', error: new Error('boom') }
      },
    )

    const visible = await getVisibleUpdates('en')
    expect(visible).toEqual([])
  })

  test('shows flagged entries via dev fallback when binding is missing outside production', async () => {
    getAllUpdatesMock.mockReturnValue([
      { ...baseEntry, slug: 'dev-on', flag: 'dev-flag' },
      { ...baseEntry, slug: 'dev-off', flag: 'other-flag' },
    ])
    evaluateFlagshipFlagMock.mockImplementation(
      async (_source: unknown, options: { flagKey: string }) => ({
        kind: 'missing-binding',
        production: false,
        enabled: options.flagKey === 'dev-flag',
      }),
    )

    const visible = await getVisibleUpdates('en')
    expect(visible.map((entry) => entry.slug)).toEqual(['dev-on'])
  })
})

describe('getVisibleUpdateBySlug', () => {
  test('returns undefined for unknown slug', async () => {
    getUpdateBySlugMock.mockReturnValue(undefined)
    await expect(
      getVisibleUpdateBySlug('missing', 'en'),
    ).resolves.toBeUndefined()
  })

  test('returns undefined when a flagged entry is hidden', async () => {
    getUpdateBySlugMock.mockReturnValue({
      ...baseEntry,
      flag: 'hidden-flag',
    })
    evaluateFlagshipFlagMock.mockResolvedValue({
      kind: 'evaluated',
      enabled: false,
    })

    await expect(
      getVisibleUpdateBySlug('2026-07-01-sample', 'en'),
    ).resolves.toBeUndefined()
  })

  test('returns entry when flag is enabled', async () => {
    const flagged = { ...baseEntry, flag: 'shown-flag' }
    getUpdateBySlugMock.mockReturnValue(flagged)
    evaluateFlagshipFlagMock.mockResolvedValue({
      kind: 'evaluated',
      enabled: true,
    })

    const visible = await getVisibleUpdateBySlug('2026-07-01-sample', 'en')
    expect(visible).toEqual({ ...baseEntry })
    expect(visible).not.toHaveProperty('flag')
  })
})

describe('getLatestVisibleNotice', () => {
  test('uses the exact UTC 14-day boundary and excludes future entries', async () => {
    getAllUpdatesMock.mockReturnValue([
      { ...baseEntry, slug: 'future', date: '2026-07-28', notice: true },
      { ...baseEntry, slug: 'current', date: '2026-07-14', notice: true },
      { ...baseEntry, slug: 'expired', date: '2026-07-13', notice: true },
    ])

    await expect(
      getLatestVisibleNotice('en', {}, new Date('2026-07-27T23:59:59.999Z')),
    ).resolves.toMatchObject({ slug: 'current' })
    await expect(
      getLatestVisibleNotice('en', {}, new Date('2026-07-27T00:00:00.000Z')),
    ).resolves.not.toMatchObject({ slug: 'expired' })
  })

  test('ignores non-notice and hidden entries and strips internal fields from payloads', async () => {
    const internal = {
      ...baseEntry,
      slug: 'latest',
      date: '2026-07-27',
      notice: true as const,
      flag: 'hidden',
    }
    getAllUpdatesMock.mockReturnValue([
      internal,
      { ...baseEntry, slug: 'ordinary', date: '2026-07-27' },
    ])
    evaluateFlagshipFlagMock.mockResolvedValue({
      kind: 'evaluated',
      enabled: false,
    })

    await expect(
      getLatestVisibleNotice('en', {}, new Date('2026-07-27T12:00:00Z')),
    ).resolves.toBeUndefined()
    expect(toListItem(internal)).not.toHaveProperty('notice')
    expect(toListItem(internal)).not.toHaveProperty('flag')
    expect(toDetail(internal)).not.toHaveProperty('notice')
    expect(toDetail(internal)).not.toHaveProperty('flag')
  })
})
