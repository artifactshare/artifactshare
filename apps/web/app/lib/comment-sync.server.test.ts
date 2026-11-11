import { describe, expect, test, vi } from 'vitest'
import { commentSyncAssignment, commentSyncFlag } from './comment-sync.server'
import { assertFlagshipRegistrationIsCurrent } from './flagship-fallback.server'

const eligible = {
  ownerWorkspaceId: 'owner-workspace',
  authenticated: true,
  historical: false,
  renderType: 'html' as const,
}
const version = {
  id: '12345678-1234-1234-1234-123456789abc',
  tag: 'not-client-metadata',
  timestamp: '2026-11-12T00:00:00Z',
}

test('temporary registration allows four weeks for paired rollout and recovery evidence', () => {
  expect(() =>
    assertFlagshipRegistrationIsCurrent(
      commentSyncFlag,
      new Date('2026-11-12T00:00:00Z'),
    ),
  ).not.toThrow()
  expect(() =>
    assertFlagshipRegistrationIsCurrent(
      commentSyncFlag,
      new Date('2026-12-11T00:00:00Z'),
    ),
  ).toThrow('expired')
})

describe('comment assignment', () => {
  test.each(['legacy', 'session'] as const)(
    'projects only valid %s and the official version ID',
    async (mode) => {
      const getStringValue = vi.fn().mockResolvedValue(mode)
      const assignment = await commentSyncAssignment(
        {
          APP_ENV: 'development',
          DEV_FLAGS: `comment-sync-engine=${mode === 'legacy' ? 'session' : 'legacy'}`,
          FLAGS: { getStringValue },
          WORKER_VERSION: version,
        },
        eligible,
      )
      expect(assignment).toEqual({ mode, build: version.id })
      expect(getStringValue).toHaveBeenCalledExactlyOnceWith(
        'comment-sync-engine',
        'legacy',
        { targetingKey: 'owner-workspace', workspaceId: 'owner-workspace' },
      )
    },
  )
  test.each(
    ['production', 'development'].flatMap((APP_ENV) =>
      [
        'invalid',
        'error',
        ...(APP_ENV === 'production' ? ['missing'] : []),
      ].map((failure) => ({ APP_ENV, failure })),
    ),
  )(
    '$APP_ENV $failure falls back without returning or logging provider details',
    async ({ APP_ENV, failure }) => {
      const getStringValue =
        failure === 'error'
          ? vi.fn().mockRejectedValue(new Error('sensitive provider detail'))
          : vi.fn().mockResolvedValue('invalid')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(
          await commentSyncAssignment(
            {
              APP_ENV,
              DEV_FLAGS: 'comment-sync-engine=session',
              FLAGS: failure === 'missing' ? undefined : { getStringValue },
            },
            eligible,
          ),
        ).toEqual({ mode: 'legacy', build: 'unknown' })
        expect(log).not.toHaveBeenCalled()
      } finally {
        log.mockRestore()
      }
    },
  )
  test.each([
    [undefined, 'legacy'],
    ['', 'legacy'],
    ['comment-sync-engine', 'legacy'],
    ['comment-sync-engine=invalid', 'legacy'],
    ['comment-sync-engine=legacy', 'legacy'],
    ['comment-sync-engine=session', 'session'],
  ] as const)(
    'local missing binding with %j selects %s',
    async (DEV_FLAGS, mode) => {
      expect(
        await commentSyncAssignment(
          { APP_ENV: 'development', DEV_FLAGS },
          eligible,
        ),
      ).toEqual({ mode, build: 'unknown' })
    },
  )
  test.each([
    { ...eligible, authenticated: false },
    { ...eligible, historical: true },
    { ...eligible, renderType: null },
  ])('ineligible display does not evaluate: %j', async (input) => {
    const getStringValue = vi.fn().mockResolvedValue('session')
    expect(
      await commentSyncAssignment(
        {
          APP_ENV: 'development',
          DEV_FLAGS: 'comment-sync-engine=session',
          FLAGS: { getStringValue },
        },
        input,
      ),
    ).toEqual({ mode: 'legacy', build: 'unknown' })
    expect(getStringValue).not.toHaveBeenCalled()
    expect(
      await commentSyncAssignment(
        { APP_ENV: 'development', DEV_FLAGS: 'comment-sync-engine=session' },
        input,
      ),
    ).toEqual({ mode: 'legacy', build: 'unknown' })
  })
  test.each(['html', 'md', 'static_site', 'pdf', 'video'] as const)(
    'keeps supported %s comments eligible',
    async (renderType) => {
      const getStringValue = vi.fn().mockResolvedValue('session')
      expect(
        (
          await commentSyncAssignment(
            { FLAGS: { getStringValue } },
            { ...eligible, renderType },
          )
        ).mode,
      ).toBe('session')
      expect(getStringValue).toHaveBeenCalledTimes(1)
    },
  )
  test.each(['', '00000000-0000-0000-0000-000000000000', 'not a version id'])(
    'missing or unsafe build metadata stays unknown: %j',
    async (id) => {
      expect(
        (
          await commentSyncAssignment(
            { WORKER_VERSION: { ...version, id } },
            eligible,
          )
        ).build,
      ).toBe('unknown')
    },
  )
})
