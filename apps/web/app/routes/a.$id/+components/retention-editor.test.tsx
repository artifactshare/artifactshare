import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { RetentionEditor } from './retention-editor'

const routeData = vi.hoisted(() => ({ locale: 'en' }))

// Keep this guard scoped to the editor: the full history panel also imports
// upload helpers whose product constants legitimately use the contract.
// Throw even when a prior build has left the contract package available.
vi.mock('@artifactshare/contract', () => {
  throw new Error(
    'Browser retention editor must not load the contract at runtime',
  )
})

vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate: vi.fn() }),
  useRouteLoaderData: () => routeData,
}))

test.each([
  ['en', null, 'Keeping all versions'],
  ['en', 1, 'Keeping only the latest version'],
  ['en', 2, 'Keeping the latest 2 versions'],
  ['ja', null, 'すべての版を保持しています'],
  ['ja', 1, '最新版のみを保持しています'],
  ['ja', 2, '最新2件の版を保持しています'],
] as const)(
  'renders %s setting %s without a runtime contract dependency',
  (locale, retainVersions, summary) => {
    routeData.locale = locale
    const html = renderToStaticMarkup(
      <RetentionEditor artifactId="s1" retainVersions={retainVersions} />,
    )

    expect(html).toContain(summary)
    expect(html).toContain('data-retention-change')
    expect(html).toContain('aria-expanded="false"')
  },
)
