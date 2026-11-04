import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import * as access from '~/modules/access'
import { ViewerShell } from './+components/viewer-shell'
import { loadPublishedViewer } from './+published-viewer-loader-fixture'

const viewerLocale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(viewerLocale.value) }))

test('published viewer fixture preserves access exports used by loader dependencies', async () => {
  const original =
    await vi.importActual<typeof import('~/modules/access')>('~/modules/access')
  expect(access.workspaceAccessRevokedSql).toBe(
    original.workspaceAccessRevokedSql,
  )
  expect(Object.keys(access).sort()).toEqual(Object.keys(original).sort())
})

test.each(
  (['en', 'ja'] as const).flatMap((locale) =>
    [false, true].flatMap((scheduled) =>
      (['owner', 'member', 'anonymous'] as const).flatMap((persona) =>
        (persona === 'anonymous' ? [false] : [false, true]).map(
          (historical) => ({ locale, scheduled, persona, historical }),
        ),
      ),
    ),
  ),
)(
  'browser fixture renders published loader output without freshness: %j',
  async (options) => {
    viewerLocale.value = options.locale
    const result = await loadPublishedViewer(options)
    expect(result.artifact.displayedVersionId).toBe(
      options.historical ? 'v0' : 'v1',
    )
    expect(result.artifact.canViewHistory).toBe(options.persona !== 'anonymous')
    if (options.persona !== 'anonymous') {
      expect(result.artifact.versions).toHaveLength(2)
      expect(
        result.artifact.versions.every(
          (version) => version.scheduledUpdate === options.scheduled,
        ),
      ).toBe(true)
    }
    const router = createMemoryRouter([
      {
        path: '/',
        Component: () => (
          <TooltipProvider>
            <ViewerShell
              artifact={result.artifact}
              user={result.user}
              renderType={null}
              sandboxUrl={null}
              bundlePaths={[]}
            />
          </TooltipProvider>
        ),
      },
    ])
    try {
      const html = renderToStaticMarkup(<RouterProvider router={router} />)
      expect(html).not.toMatch(/Data updated|データ更新/)
      const aside = html
        .split('<aside')
        .slice(1)
        .find((part) =>
          part
            .split('>')[0]
            .includes(bindI18n(options.locale).t('vw.activityStatus')),
        )
      expect(aside).toBeDefined()
      expect(aside!.split('>')[0].includes('hidden=""')).toBe(
        options.persona === 'anonymous',
      )
    } finally {
      router.dispose()
    }
  },
)

test('viewer loader distinguishes successful empty grants from unavailable or redacted evidence', async () => {
  const options = { locale: 'en' as const, scheduled: false, historical: false }
  const owner = await loadPublishedViewer({ ...options, persona: 'owner' })
  expect(owner.artifact.hasDirectGrants).toBe(false)
  const { listGrants } = await import('~/services/shareables.server')
  vi.mocked(listGrants).mockResolvedValueOnce({ kind: 'not-found' })
  const failed = await loadPublishedViewer({ ...options, persona: 'owner' })
  expect(failed.artifact.grants).toEqual([])
  expect(failed.artifact.hasDirectGrants).toBeUndefined()
  const viewer = await loadPublishedViewer({ ...options, persona: 'member' })
  expect(viewer.artifact.grants).toEqual([])
  expect(viewer.artifact.hasDirectGrants).toBeUndefined()
})
