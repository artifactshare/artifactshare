import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import type { FileRowData } from './file-data'
import { HomeUnopenedFiles } from './home-unopened-files'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'ja',
    t: (key: string) =>
      ({
        'home.unopenedTitle': '未確認のファイル',
        'home.unopenedDescription': '自分が作成し、まだ開いていないファイル',
        'home.unopenedError': '未確認のファイルを読み込めませんでした。',
        'home.unopenedSeeAll': '自分のファイルをすべて見る',
        'home.reload': '再読み込み',
      })[key] ?? key,
  }),
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
  hasMore?: boolean
  error?: boolean
}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(HomeUnopenedFiles, {
        files: props.files ?? [],
        hasMore: props.hasMore ?? false,
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

  test('shows owned unopened files and the existing all-files destination', () => {
    const html = render({ files: [file], hasMore: true })

    expect(html).toContain('未確認のファイル')
    expect(html).toContain('自分が作成し、まだ開いていないファイル')
    expect(html).toContain('確認するレポート')
    expect(html).toContain('採用指針')
    expect(html).toContain('href="/a/unopened-file"')
    expect(html).not.toContain('aria-label="確認するレポート"')
    expect(html).toContain('href="/files"')
    expect(html).not.toContain('Codex')
    expect(html).not.toContain('Claude')
  })

  test('keeps the section error local', () => {
    const html = render({ error: true })

    expect(html).toContain('未確認のファイルを読み込めませんでした。')
    expect(html).toContain('href="."')
  })
})
