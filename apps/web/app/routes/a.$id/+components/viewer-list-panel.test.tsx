import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import type { ViewerListRowView, ViewerListStatus } from './viewer-shell'
import { ViewerListPanelBody, viewerListInitial } from './viewer-list-panel'

const { t } = bindI18n('en')

function row(overrides: Partial<ViewerListRowView> = {}): ViewerListRowView {
  return {
    userId: 'viewer-1',
    name: 'Alice Cooper',
    image: null,
    lastViewedAt: '2024-01-01T09:00:00Z',
    isSelf: false,
    ...overrides,
  }
}

function renderBody({
  rows = [] as ReadonlyArray<ViewerListRowView>,
  status = 'loaded' as ViewerListStatus,
  loadingMore = false,
  nextCursor = null as string | null,
} = {}) {
  return renderToStaticMarkup(
    <ViewerListPanelBody
      rows={rows}
      status={status}
      loadingMore={loadingMore}
      nextCursor={nextCursor}
      onLoadMore={() => {}}
      onRetry={() => {}}
      locale="en"
      t={t}
    />,
  )
}

describe('viewerListInitial', () => {
  test('uppercases the first character after trimming', () => {
    expect(viewerListInitial('  alice ')).toBe('A')
    expect(viewerListInitial('田中')).toBe('田')
  })

  test('falls back to "?" for null, empty, and whitespace-only names', () => {
    expect(viewerListInitial(null)).toBe('?')
    expect(viewerListInitial('')).toBe('?')
    expect(viewerListInitial('   ')).toBe('?')
  })
})

describe('ViewerListPanelBody', () => {
  test('renders viewer rows with name and relative last-viewed time', () => {
    const html = renderBody({ rows: [row()] })
    expect(html).toContain('Alice Cooper')
    // canonical timestamp renders a relative label, not the dash fallback
    expect(html).not.toContain('>—<')
  })

  test('marks the requesting user with the me badge', () => {
    const html = renderBody({
      rows: [row(), row({ userId: 'viewer-2', name: 'Me', isSelf: true })],
    })
    expect(html).toContain('>me</span>')
  })

  test('shows the unknown-user label and "?" initial for blank names', () => {
    const html = renderBody({
      rows: [row({ name: '   ' }), row({ userId: 'viewer-2', name: null })],
    })
    expect(html).toContain('Unknown user')
    expect(html).toContain('>?<')
  })

  test('renders a dash for non-canonical last-viewed timestamps', () => {
    const html = renderBody({
      rows: [
        row({ lastViewedAt: '2024-01-01 09:00:00' }),
        row({
          userId: 'viewer-2',
          lastViewedAt: '2024-01-01T09:00:00+09:00',
        }),
      ],
    })
    expect(html.match(/>—</g)).toHaveLength(2)
  })

  test('renders the empty state when nobody in the company viewed yet', () => {
    const html = renderBody({ rows: [] })
    expect(html).toContain('No one in your company has viewed this yet.')
  })

  test('renders the loading state', () => {
    const html = renderBody({ status: 'loading' })
    expect(html).toContain('Loading…')
  })

  test('renders the error state with a retry button', () => {
    const html = renderBody({ status: 'error' })
    expect(html).toContain('Could not load the list.')
    expect(html).toContain('>Retry</button>')
  })

  test('renders the load-more button only when a next cursor exists', () => {
    expect(renderBody({ rows: [row()], nextCursor: 'cursor-1' })).toContain(
      'Show more',
    )
    expect(renderBody({ rows: [row()] })).not.toContain('Show more')
  })

  test('always renders the three footer sentences', () => {
    for (const html of [
      renderBody({ rows: [row()] }),
      renderBody({ rows: [] }),
      renderBody({ status: 'loading' }),
      renderBody({ status: 'error' }),
    ]) {
      expect(html).toContain(
        'Your views are also shown to people in your company who can view this file.',
      )
      expect(html).toContain('Only views from inside your company are shown.')
      expect(html).toContain(
        'This is a record of opening the file, not confirmation it was read.',
      )
    }
  })
})
