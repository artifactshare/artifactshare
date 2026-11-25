import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { bindI18n, t, type Locale, type TKey } from '~/lib/i18n'
import type { FeedEventRow } from '~/services/events.server'

const state = vi.hoisted(() => ({ locale: 'ja' as Locale }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(state.locale),
}))
vi.mock('react-router', () => ({
  // data-slot 等の注入 props (Radix asChild) を落とさないよう rest を通す
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: string
    to: string
  } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/' }),
}))
vi.mock('~/lib/datetime', () => ({ formatRelative: () => 'now' }))

import { FeedItem } from './feed-item'

const row = (overrides: Partial<FeedEventRow>): FeedEventRow => ({
  id: 'event',
  type: 'version_published',
  shareableId: 'share-1',
  shareableTitle: 'Title',
  actorId: 'actor-1',
  actorName: 'Alice',
  versionNumber: 2,
  versionStart: null,
  versionEnd: null,
  versionAuthorCount: null,
  commentBody: null,
  commentCount: null,
  viewUniqueCount: null,
  anonymousViewCount: null,
  viewedFileCount: null,
  viewTopItems: null,
  createdAt: '2026-01-02T00:00:00Z',
  dayKey: '2026-01-02',
  isViewerInbox: false,
  ...overrides,
})

// The renderer splits a sentence at its {title} and {project} placeholders to
// insert links, so catalog copy reaches the markup as ordered fragments.
function expectCopy(
  html: string,
  key: TKey,
  vars: Record<string, string | number> = {},
) {
  const copy = t(state.locale, key, {
    title: '{title}',
    project: '{project}',
    ...vars,
  })
  let at = 0
  for (const fragment of copy.split(/\{title\}|\{project\}/)) {
    if (fragment === '') continue
    const found = html.indexOf(fragment, at)
    expect(found, `${key}: ${fragment}`).toBeGreaterThanOrEqual(0)
    at = found + fragment.length
  }
}

describe('FeedItem version copy', () => {
  test.each(['ja', 'en'] as const)(
    'renders the single-version copy in %s',
    (locale) => {
      state.locale = locale
      expectCopy(
        renderToStaticMarkup(<FeedItem row={row({})} />),
        'home.actorPublishedInline',
        { actor: 'Alice', version: 2 },
      )
    },
  )

  test.each(['ja', 'en'] as const)(
    'renders named and anonymous ranges in %s',
    (locale) => {
      state.locale = locale
      expectCopy(
        renderToStaticMarkup(
          <FeedItem
            row={row({ versionStart: 2, versionEnd: 3, versionAuthorCount: 1 })}
          />,
        ),
        'home.actorPublishedRangeInline',
        { actor: 'Alice', start: 2, end: 3 },
      )
      const anonymous = renderToStaticMarkup(
        <FeedItem
          row={row({ versionStart: 2, versionEnd: 3, versionAuthorCount: 2 })}
        />,
      )
      expectCopy(anonymous, 'home.publishedRangeInline', { start: 2, end: 3 })
      expect(anonymous).not.toContain('Alice')
    },
  )

  test('links to the artifact', () => {
    expect(renderToStaticMarkup(<FeedItem row={row({})} />)).toContain(
      'href="/a/share-1"',
    )
  })

  test.each(['ja', 'en'] as const)(
    'renders aggregated comment copy and quote in %s',
    (locale) => {
      state.locale = locale
      const html = renderToStaticMarkup(
        <FeedItem
          row={row({
            type: 'comment_posted',
            commentCount: 3,
            commentBody: 'quoted text',
          })}
        />,
      )
      expectCopy(html, 'home.actorCommentedCountInline', {
        actor: 'Alice',
        count: 3,
      })
      expect(html).toContain('quoted text')
    },
  )

  test('renders individual comment copy when count is null', () => {
    state.locale = 'ja'
    expectCopy(
      renderToStaticMarkup(
        <FeedItem row={row({ type: 'comment_posted', commentCount: null })} />,
      ),
      'home.actorCommentedInline',
      { actor: 'Alice' },
    )
  })

  test.each([
    [
      { viewUniqueCount: 2, anonymousViewCount: 0 },
      'home.viewDigest_other' as TKey,
      { files: 3, count: 2 },
    ],
    [
      { viewUniqueCount: 0, anonymousViewCount: 1 },
      'home.viewDigestAnonymous_one' as TKey,
      { files: 3, count: 1 },
    ],
    [
      { viewUniqueCount: 1, anonymousViewCount: 2 },
      'home.viewDigest_one' as TKey,
      { files: 3, count: 1 },
    ],
  ])('renders digest copy and links top items', (counts, key, vars) => {
    state.locale = 'en'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [
            { shareableId: 'top-1', title: 'First', count: 4 },
            { shareableId: 'top-2', title: 'Second', count: 2 },
          ],
          ...counts,
        })}
      />,
    )
    expectCopy(html, key, vars)
    if (counts.viewUniqueCount && counts.anonymousViewCount)
      expectCopy(html, 'home.anonymousViewsSuffix_other', {
        count: counts.anonymousViewCount,
      })
    expect(html).toContain('href="/a/top-1"')
    expect(html).toContain('href="/a/top-2"')
    expect(html).toContain(
      'First</a><span class="text-muted-foreground"> (4)</span>',
    )
    expect(html).toContain('First</a>')
    expect(html).not.toContain('First (4)</a>')
    expect(html).toContain(
      ` (4)</span></span><span>${t('en', 'home.listSeparator')}<a href="/a/top-2"`,
    )
  })

  test('digest rows carry no place meta even with showLocation', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [{ shareableId: 'top-1', title: 'First', count: 4 }],
          isViewerInbox: true,
        })}
      />,
    )
    expect(html).not.toContain('tabler-icon-home')
    expect(html).not.toContain(t('ja', 'tb.home'))
  })
})

describe('FeedItem event icon semantics', () => {
  function iconMarkup(html: string) {
    const match = html.match(/(<span aria-hidden="true"[^>]*>.*?<\/span>)/)
    return match?.[1] ?? ''
  }

  test.each([
    ['artifact_viewed', 'tabler-icon-eye', 'bg-link-soft text-link'],
    ['comment_posted', 'tabler-icon-message', 'text-link'],
    [
      'version_published',
      'tabler-icon-git-branch',
      'bg-warning-soft text-warning',
    ],
    ['artifact_created', 'tabler-icon-plus', 'bg-muted text-muted-foreground'],
  ] as const)(
    '%s uses the intended icon and meaning color',
    (type, icon, color) => {
      state.locale = 'en'
      const markup = iconMarkup(
        renderToStaticMarkup(<FeedItem row={row({ type })} />),
      )
      expect(markup).not.toBe('')
      expect(markup).toContain(icon)
      expect(markup).toContain(
        `class="flex size-6 shrink-0 items-center justify-center rounded ${color}"`,
      )
      if (type === 'comment_posted') {
        expect(markup).not.toContain('bg-success')
        expect(markup).not.toContain('text-success')
      }
    },
  )

  test('comments use the same blue as views but remain distinguishable by icon and background', () => {
    state.locale = 'en'
    const comment = iconMarkup(
      renderToStaticMarkup(<FeedItem row={row({ type: 'comment_posted' })} />),
    )
    const view = iconMarkup(
      renderToStaticMarkup(<FeedItem row={row({ type: 'artifact_viewed' })} />),
    )
    expect(comment).toContain('tabler-icon-message')
    expect(comment).not.toContain('bg-link-soft')
    expect(comment).toContain('text-link')
    expect(view).toContain('tabler-icon-eye')
    expect(view).toContain('bg-link-soft text-link')
  })

  test.each(['comment_posted', 'artifact_viewed'] as const)(
    '%s keeps the same icon semantics in compact mode',
    (type) => {
      state.locale = 'en'
      const regular = iconMarkup(
        renderToStaticMarkup(<FeedItem row={row({ type })} />),
      )
      const compact = iconMarkup(
        renderToStaticMarkup(<FeedItem compact row={row({ type })} />),
      )
      expect(compact).toBe(regular)
    },
  )
})

describe('FeedItem add bundle', () => {
  test('bundled additions show the count text and link to the project files page', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_created',
          addCount: 3,
          containerId: 'proj1',
          containerName: 'Project One',
        })}
      />,
    )
    expectCopy(html, 'home.actorAddedToProjectCount', {
      actor: 'Alice',
      count: 3,
    })
    expect(html).toContain('href="/projects/proj1/files"')
    expect(html).not.toContain('href="/a/share-1"')
  })

  test('a single addition keeps the individual row and artifact link', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem row={row({ type: 'artifact_created', addCount: null })} />,
    )
    expectCopy(html, 'home.actorAddedInline', { actor: 'Alice' })
    expect(html).toContain('href="/a/share-1"')
  })
})

describe('FeedItem location meta', () => {
  test('project rows show the project mark and name with showLocation', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({ containerKind: 'project', containerName: 'Metrics' })}
      />,
    )
    expect(html).toContain('tabler-icon-stack-2')
    expect(html).toContain('Metrics')
  })

  test('own inbox rows show home icon and label', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({ containerKind: 'inbox', isViewerInbox: true })}
      />,
    )
    expect(html).toContain('tabler-icon-home')
    expect(html).toContain(t('ja', 'tb.home'))
  })

  test("someone else's inbox rows show time only", () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          containerKind: 'inbox',
          containerName: '未整理',
          isViewerInbox: false,
        })}
      />,
    )
    expect(html).not.toContain('tabler-icon-home')
    expect(html).not.toContain('tabler-icon-stack-2')
    expect(html).not.toContain('未整理')
  })

  test('without showLocation (project context) no place renders', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({ containerKind: 'project', containerName: 'Metrics' })}
      />,
    )
    expect(html).not.toContain('tabler-icon-stack-2')
  })

  test('add bundles keep time only and no trailing title link line', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          type: 'artifact_created',
          addCount: 3,
          containerId: 'p1',
          containerKind: 'project',
          containerName: 'Metrics',
        })}
      />,
    )
    const meta = html.split('<time')[1] ?? ''
    expect(meta).not.toContain('tabler-icon-stack-2')
  })

  test('the meta line uses a machine-readable time element', () => {
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    expect(html).toContain('dateTime="2026-01-02T00:00:00Z"')
  })

  test('inline title links carry no hover preview', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem row={row({ type: 'comment_posted', commentBody: 'quote' })} />,
    )
    expect(html).not.toContain('hover-card-trigger')
    expect(renderToStaticMarkup(<FeedItem row={row({})} />)).not.toContain(
      'hover-card-trigger',
    )
  })

  test('single anonymous view rows keep the inline title link', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewUniqueCount: null,
          anonymousViewCount: 3,
        })}
      />,
    )
    expect(html).toContain('href="/a/share-1"')
  })
})

describe('FeedItem title line wrapping', () => {
  function firstLineClassName(html: string) {
    const match = html.match(
      /<div class="min-w-0 flex-1">\s*<div class="([^"]*)"/,
    )
    return match?.[1] ?? ''
  }

  test('first line does not use truncate', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    // 正の対照: className を取り出せていることを先に確かめる。取り出しに
    // 失敗すると '' が返り、not.toContain が無条件に通ってしまう。
    expect(firstLineClassName(html)).not.toBe('')
    expect(firstLineClassName(html)).not.toContain('truncate')
  })

  test('first line uses wrap-anywhere', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    expect(firstLineClassName(html)).toContain('wrap-anywhere')
  })

  test('view digest top list clamps only below the stack breakpoint', () => {
    state.locale = 'en'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [{ shareableId: 'top-1', title: 'First', count: 4 }],
          viewUniqueCount: 2,
          anonymousViewCount: 0,
        })}
      />,
    )
    const match = html.match(
      new RegExp(
        `<div class="text-muted-foreground ([^"]*)">${t('en', 'home.viewDigestTop')}`,
      ),
    )
    const className = match?.[1] ?? ''
    // desktop で clamp すると 3 件目が隠れるため、前置修飾ごと固定する。
    // toContain('line-clamp-2') では無条件の clamp でも通ってしまう。
    expect(className).toContain('max-stack:line-clamp-2')
    expect(className).toContain('wrap-anywhere')
  })

  test('aggregated comment row renders full copy including count', () => {
    state.locale = 'ja'
    const longActor = 'あ'.repeat(32)
    const longTitle = 'い'.repeat(80)
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'comment_posted',
          actorName: longActor,
          shareableTitle: longTitle,
          commentCount: 3,
        })}
      />,
    )
    expectCopy(html, 'home.actorCommentedCountInline', {
      actor: longActor,
      count: 3,
    })
    expect(html).toContain(longTitle)
  })
})
