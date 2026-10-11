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
  ['ja', null, 'すべての版を残しています'],
  ['ja', 1, '最新版だけを残しています'],
  ['ja', 2, '最新2件の版を残しています'],
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

test.each(['en', 'ja'] as const)(
  'managed %s editor explains protection even when unlimited',
  (locale) => {
    routeData.locale = locale
    for (const retainVersions of [null, 1, 2]) {
      const html = renderToStaticMarkup(
        <RetentionEditor
          artifactId="s1"
          retainVersions={retainVersions}
          publisherManaged
        />,
      )
      expect(html).toContain(
        locale === 'en'
          ? 'All versions people added are kept'
          : '人が追加した版はすべて残します',
      )
      expect(html).toContain(
        locale === 'en'
          ? 'Keep the latest scheduled versions'
          : '最新の定期更新の版を残す',
      )
      if (retainVersions !== null)
        expect(html).toContain(
          locale === 'en'
            ? retainVersions === 1
              ? 'Keeping the latest scheduled version.'
              : 'Keeping the latest 2 scheduled versions.'
            : `最新${retainVersions}件の定期更新の版`,
        )
    }
    const unmanaged = renderToStaticMarkup(
      <RetentionEditor artifactId="s1" retainVersions={1} />,
    )
    expect(unmanaged).not.toContain(
      locale === 'en' ? 'All versions people added' : '人が追加した版',
    )
  },
)
