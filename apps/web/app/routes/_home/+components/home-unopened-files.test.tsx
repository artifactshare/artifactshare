import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import type { FileRowData } from './file-data'
import { HomeUnopenedFiles } from './home-unopened-files'

import { bindI18n, t } from '~/lib/i18n'
const language = vi.hoisted(() => ({ locale: 'ja' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(language.locale),
}))

vi.mock('~/hooks/use-viewer-calendar', () => ({
  useViewerCalendar: () => ({ hydrated: true, timeZone: 'Asia/Tokyo' }),
}))

const file: FileRowData = {
  id: 'unopened-file',
  fileName: 'report.html',
  derivedTitle: '確認するレポート',
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  visibility: 'private',
  viewCount: 0,
  commentCount: 0,
  modifiedTime: '2026-08-24T06:00:00.000Z',
  createdTime: '2026-08-24T06:00:00.000Z',
  projectName: '採用指針',
}

function render(props: {
  files?: FileRowData[]
  total?: number
  error?: boolean
}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(HomeUnopenedFiles, {
        files: props.files ?? [],
        total: props.total ?? props.files?.length ?? 0,
        error: props.error ?? false,
        now: '2026-08-24T07:00:00.000Z',
      }),
    ),
  )
}

describe('HomeUnopenedFiles', () => {
  test('omits the section when there are no files and no error', () => {
    expect(render({})).toBe('')
  })

  test('shows owned unopened files with the all-files link when none remain', () => {
    const html = render({ files: [file] })

    expect(html).toContain('未確認のファイル')
    expect(html).toContain('自分が作成し、まだ開いていないファイル')
    expect(html).toContain('確認するレポート')
    expect(html).toContain('採用指針')
    expect(html).toContain('href="/a/unopened-file"')
    expect(html).not.toContain('aria-label="確認するレポート"')
    expect(html).toContain('href="/files"')
    expect(html).toContain(t('ja', 'home.unopenedSeeAll'))
    expect(html).not.toContain('Codex')
    expect(html).not.toContain('Claude')
  })

  test('keeps the section error local', () => {
    const html = render({ error: true })

    expect(html).toContain('未確認のファイルを読み込めませんでした。')
    expect(html).toContain('href="."')
  })
})

test.each(['en', 'ja'] as const)(
  'keeps the all-files link for one to five files and shows remaining counts for six and twelve in %s',
  (locale) => {
    language.locale = locale
    for (const total of [1, 5, 6, 12]) {
      const files = Array.from({ length: Math.min(total, 5) }, (_, i) => ({
        ...file,
        id: `file-${i}`,
      }))
      const html = render({ files, total })
      if (total <= files.length) {
        expect(html).toContain('href="/files"')
        expect(html).toContain(t(locale, 'home.unopenedSeeAll'))
      } else {
        expect(html).toContain('href="/files"')
        expect(html).toContain(
          locale === 'en'
            ? total === 6
              ? 'See 1 more unopened file</a>'
              : 'See 7 more unopened files</a>'
            : `未確認のファイルをさらに見る（${total - 5} 件）`,
        )
      }
    }
    expect(render({ files: [file], total: 12, error: true })).not.toContain(
      'href="/files"',
    )
    language.locale = 'ja'
  },
)
