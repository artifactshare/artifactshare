import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { EmptyState } from './empty-state'

let mockedLocale = 'en' as 'en' | 'ja'
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockedLocale,
    t: (key: string) =>
      ({
        'empty.title':
          mockedLocale === 'ja' ? 'ファイルがありません' : 'No files yet',
        'empty.body':
          mockedLocale === 'ja'
            ? 'ファイルを追加してください。'
            : 'Add a file to get started.',
        'empty.connect':
          mockedLocale === 'ja'
            ? 'AI から直接共有する →'
            : 'Share straight from your AI →',
        'empty.productGuide':
          mockedLocale === 'ja'
            ? 'Artifact Shareでできることを知り、ブラウザ、CLI、MCPの3つから始め方を選べます。'
            : 'Learn what Artifact Share does and choose how to get started in your browser, with the CLI, or via MCP.',
        'empty.about':
          mockedLocale === 'ja'
            ? 'Artifact Shareについて'
            : 'About Artifact Share',
        'empty.start': mockedLocale === 'ja' ? '始め方' : 'Get started',
        'upload.cta.primary': mockedLocale === 'ja' ? 'アップロード' : 'Upload',
        'recent.empty.title':
          mockedLocale === 'ja'
            ? '最近のファイルはありません'
            : 'No recent files',
        'recent.empty.body':
          mockedLocale === 'ja'
            ? '最近のファイルがここに表示されます。'
            : 'Recent files will appear here.',
      })[key] ?? key,
  }),
}))

describe('EmptyState', () => {
  test.each([
    ['en', '/connect', '/about', '/start'],
    ['ja', '/ja/connect', '/ja/about', '/ja/start'],
  ] as const)(
    'renders files guidance and locale links for %s',
    (locale, connect, about, start) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <EmptyState />
        </MemoryRouter>,
      )
      expect(html).toContain(locale === 'ja' ? 'アップロード' : 'Upload')
      expect(html).toContain(`href="${connect}"`)
      expect(html).toContain(`href="${about}"`)
      expect(html).toContain(`href="${start}"`)
      expect(html).toContain(
        locale === 'ja'
          ? 'Artifact Shareでできることを知り、ブラウザ、CLI、MCPの3つから始め方を選べます。'
          : 'Learn what Artifact Share does and choose how to get started in your browser, with the CLI, or via MCP.',
      )
      expect(html).toContain('flex-wrap')
    },
  )

  test('does not show files guidance in recent state', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EmptyState variant="recent" />
      </MemoryRouter>,
    )
    expect(html).toContain('No recent files')
    expect(html).not.toContain('href="/connect"')
    expect(html).not.toContain('Upload')
  })

  test('keeps files guidance while hiding the upload action', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EmptyState showUploadAction={false} />
      </MemoryRouter>,
    )
    expect(html).not.toContain('>Upload<')
    expect(html).toContain('href="/connect"')
  })
})
