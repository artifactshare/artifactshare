// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { act, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import { messageCursor } from '~/lib/comment-cursor'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
const locale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
afterEach(() => {
  locale.value = 'en'
})
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: locale.value,
    t: (key: keyof typeof en) => (locale.value === 'en' ? en : ja)[key],
    tPlural: (key: string, count: number) =>
      (locale.value === 'en' ? en : ja)[
        `${key}${count === 1 ? 'One' : 'Other'}` as keyof typeof en
      ].replace('{n}', String(count)),
  }),
}))
vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({ setCommentPanelOpen: vi.fn() }),
}))
vi.mock('~/components/app/app-side-panel', async () => {
  const { Dialog } = await import('~/components/ui/dialog')
  return {
    AppSidePanel: ({ children }: { children: ReactNode }) => (
      <Dialog open>
        <div>{children}</div>
      </Dialog>
    ),
  }
})
import { CommentPanel } from './comment-panel'
import { useViewerComments } from './viewer-shell'
import { mergeCommentWindow } from './comment-history'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'

type PositionState = 'attached' | 'needs-check' | 'unchecked'

function textThread(
  positionState: PositionState,
  id = 'thread-1',
  quotedText = 'Original words',
): CommentThreadView {
  return {
    id,
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    canResolve: false,
    messageCount: 0,
    replyCount: 0,
    olderCursor: null,
    messages: [],
    subject: {
      kind: 'text',
      state: positionState === 'attached' ? 'attached' : 'orphaned',
      positionState,
      quotedText,
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  }
}

function render(positionState: PositionState) {
  return renderThreads([textThread(positionState)])
}

function renderThreads(
  threads: CommentThreadView[],
  newCommentMessages: Array<{ messageId: string; threadId: string }> = [],
  targetThreadId: string | null = null,
  requestedFilter?: 'all',
) {
  return renderToStaticMarkup(
    <CommentPanel
      shareableId="artifact"
      viewerUserId="viewer"
      threads={threads}
      newCommentMessages={newCommentMessages}
      onThreadsChange={() => {}}
      isCurrentShareableId={() => true}
      open
      onOpenChange={() => {}}
      targetThreadId={targetThreadId}
      requestedFilter={requestedFilter}
      targetThreadScroll="center"
      onThreadNavigate={() => {}}
    />,
  )
}
test.each(['en', 'ja'] as const)(
  'needs-check retains the quote, shows localized guidance and disables jump (%s)',
  (language) => {
    locale.value = language
    const html = render('needs-check')
    expect(html).toContain('Original words')
    expect(html).toContain(
      renderToStaticMarkup(
        <strong className="">
          {(language === 'en' ? en : ja)['comments.subjectOrphaned']}
        </strong>,
      ),
    )
    expect(html).not.toContain(' data-comment-thread-hitarea=""')
    // Negative control: attached threads still provide navigation.
    expect(render('attached')).toContain(' data-comment-thread-hitarea=""')
    expect(render('unchecked')).toContain(
      (language === 'en' ? en : ja)['comments.positionChecking'],
    )
  },
)

test('a text comment keeps its list position while its check finishes', () => {
  const artifactThread: CommentThreadView = {
    ...textThread('attached', 'thread-artifact'),
    subject: { kind: 'artifact' },
  } as CommentThreadView
  locale.value = 'en'
  const order = (state: PositionState) => {
    const html = renderThreads([
      artifactThread,
      textThread(state, 'thread-text', 'Checked words'),
    ])
    const artifactAt = html.indexOf(en['comments.subjectArtifact'])
    expect(artifactAt).toBeGreaterThan(-1)
    return html.indexOf('Checked words') < artifactAt
  }
  expect(order('unchecked')).toBe(order('attached'))
  expect(order('attached')).toBe(true)
  expect(order('needs-check')).toBe(false)
})

test('checking is neutral; only a missing quote uses warning colors', () => {
  locale.value = 'en'
  expect(render('unchecked')).not.toContain('text-warning')
  expect(render('unchecked')).toContain(en['comments.positionChecking'])
  expect(render('needs-check')).toContain('text-warning')
  const thread = textThread('unchecked')
  if (thread.subject.kind === 'text') thread.subject.checking = false
  const html = renderThreads([thread])
  expect(html).toContain('Original words')
  expect(html).not.toContain('text-warning')
  expect(html).not.toContain(en['comments.positionChecking'])
  expect(html).not.toContain(' data-comment-thread-hitarea=""')
})

test('the first panel render checks an unchecked thread only when a frame is present', () => {
  locale.value = 'en'
  const initialThreads = [textThread('unchecked')]
  function FirstRenderPanel({ framePresent }: { framePresent: boolean }) {
    const comments = useViewerComments({
      framePresent,
      artifactId: 'abc123def4',
      currentUserId: 'viewer',
      currentVersionId: 'v1',
      initialThreads,
      targetCommentId: null,
      liveEnabled: false,
    })
    expect(comments.state.threads[0].subject).toEqual(initialThreads[0].subject)
    return (
      <CommentPanel
        shareableId="abc123def4"
        viewerUserId="viewer"
        threads={comments.panelThreads}
        onThreadsChange={comments.replaceThreads}
        isCurrentShareableId={comments.isCurrentArtifactId}
        open
        onOpenChange={comments.changePanelOpen}
        targetThreadId={null}
        targetThreadScroll="center"
        onThreadNavigate={() => {}}
      />
    )
  }
  // No passive effects or availability setter run during server rendering.
  const withFrame = renderToStaticMarkup(<FirstRenderPanel framePresent />)
  expect(withFrame).toContain('Original words')
  expect(withFrame).toContain(en['comments.positionChecking'])
  expect(withFrame).not.toContain('text-warning')
  const withoutFrame = renderToStaticMarkup(
    <FirstRenderPanel framePresent={false} />,
  )
  expect(withoutFrame).toContain('Original words')
  expect(withoutFrame).not.toContain(en['comments.positionChecking'])
  expect(withoutFrame).toContain(
    renderToStaticMarkup(
      <strong className="hidden">{en['comments.subjectOrphaned']}</strong>,
    ),
  )
  expect(withoutFrame).not.toContain('text-warning')
})

test.each(['en', 'ja'] as const)(
  'marks selected roots and replies with one card marker per thread (%s)',
  (language) => {
    locale.value = language
    const makeMessage = (id: string) => ({
      id,
      body: id,
      agent: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: {
        id: 'u2',
        name: 'Reviewer',
        email: 'reviewer@example.com',
        image: null,
      },
      canEdit: false,
      canDelete: false,
    })
    const root = {
      ...textThread('attached', 'root'),
      messages: [makeMessage('new-root')],
    }
    const replies = {
      ...textThread('attached', 'replies'),
      messages: [
        'old-root',
        'hidden-new',
        'old-reply-1',
        'old-reply-2',
        'visible-new',
      ].map(makeMessage),
    }
    const old = {
      ...textThread('attached', 'old'),
      messages: [makeMessage('old-message')],
    }
    const pairs = [
      { threadId: 'root', messageId: 'new-root' },
      { threadId: 'replies', messageId: 'hidden-new' },
      { threadId: 'replies', messageId: 'visible-new' },
      { threadId: 'old', messageId: 'deleted-message' },
    ]
    const html = renderThreads([root, replies, old], pairs)
    const label = language === 'en' ? 'New' : '新着'
    expect(html.match(new RegExp(`>${label}<`, 'g'))).toHaveLength(4)
    expect(html.match(/data-new-comment-thread="true"/g)).toHaveLength(2)
    expect(html.match(/data-new-comment-message="true"/g)).toHaveLength(2)
    expect(html).not.toContain('hidden-new')
    // A collapsed selected reply still marks its card without marking other messages.
    const collapsed = renderThreads(
      [replies],
      [{ threadId: 'replies', messageId: 'hidden-new' }],
    )
    expect(collapsed).toContain('data-new-comment-thread="true"')
    expect(collapsed).not.toContain('data-new-comment-message')
    const unmarked = renderThreads([root, replies, old])
    expect(unmarked).not.toContain(`>${label}<`)
    expect(unmarked).not.toContain('data-new-comment-thread')
  },
)

test('a resolved revisit target expands thread pagination while the requested all filter stays authoritative', () => {
  const target: CommentThreadView = {
    ...textThread('attached', 'thread-target'),
    status: 'resolved',
    subject: { kind: 'artifact' },
    messages: [
      {
        id: 'new-message',
        body: 'New reaction in a resolved thread',
        agent: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        author: {
          id: 'u2',
          name: 'Reviewer',
          email: 'reviewer@example.com',
          image: null,
        },
        canEdit: false,
        canDelete: false,
      },
    ],
  }
  const threads = [
    ...Array.from({ length: 50 }, (_, index) =>
      textThread('attached', `old-${index}`),
    ),
    target,
  ]
  const pairs = [{ messageId: 'new-message', threadId: target.id }]
  expect(renderThreads(threads, pairs, null, 'all')).not.toContain(
    'New reaction in a resolved thread',
  )
  const html = renderThreads(threads, pairs, target.id, 'all')
  expect(html).toContain('aria-labelledby="comment-card-header-thread-target"')
  expect(html).toContain('id="comment-card-header-thread-target"')
  expect(html).not.toContain('aria-label="New reaction in a resolved thread"')
  expect(html).toContain('tabindex="-1"')
  expect(html).toContain('data-new-comment-thread="true"')
  expect(html.match(/<article/g)).toHaveLength(51)
})

test('a target reveals selected replies older than its reply page while ordinary cards keep pagination', () => {
  const thread: CommentThreadView = {
    ...textThread('attached'),
    messages: Array.from({ length: 56 }, (_, index) => ({
      id: `message-${index}`,
      body: `Reply body ${index}.`,
      agent: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: {
        id: 'u2',
        name: 'Reviewer',
        email: 'reviewer@example.com',
        image: null,
      },
      canEdit: false,
      canDelete: false,
    })),
  }
  const pairs = [2, 54].map((index) => ({
    threadId: thread.id,
    messageId: `message-${index}`,
  }))
  const target = renderThreads([thread], pairs, thread.id, 'all')
  expect(target).toContain('Reply body 2.')
  expect(target).toContain('Reply body 54.')
  expect(target).toContain('Reply body 1.')
  expect(target.match(/data-new-comment-message="true"/g)).toHaveLength(2)
  const ordinary = renderThreads([thread], pairs)
  expect(ordinary).not.toContain('Reply body 2.')
  expect(ordinary.match(/data-new-comment-message="true"/g)).toHaveLength(1)
  expect(ordinary).toContain('data-new-comment-thread="true"')
  const unmarkedTarget = renderThreads([thread], [], thread.id, 'all')
  expect(unmarkedTarget).toContain('Reply body 2.')
  expect(unmarkedTarget).not.toContain('data-new-comment-message')
})

test.each(['en', 'ja'] as const)(
  'cached but collapsed replies are counted as more, not unloaded (%s)',
  (language) => {
    locale.value = language
    const at = '2026-05-01T00:00:00.000Z'
    const row = (i: number) => ({
      id: `message-${i}`,
      body: `Cached reply ${i}`,
      createdAt: at,
      updatedAt: at,
      agent: null,
      author: {
        id: 'reviewer',
        name: 'Reviewer',
        email: 'reviewer@example.com',
        image: null,
      },
      canEdit: false,
      canDelete: false,
    })
    const cursor = (i: number) =>
      btoa(JSON.stringify([1, 'thread', at, row(i).id]))
    const cached: CommentThreadView = {
      ...textThread('attached', 'thread'),
      messageCount: 21,
      replyCount: 20,
      olderCursor: null,
      messages: [0, 1, 2, 7, 8, 9].map(row),
      latestReplyIds: [7, 8, 9].map((i) => row(i).id),
      loadedPages: [{ through: cursor(2), limit: 2, coverageStart: cursor(1) }],
    }
    const html = renderThreads([cached])
    expect(html).toContain(
      language === 'en' ? 'Show 17 more replies' : '返信をあと17件表示',
    )
    expect(html).not.toContain('Cached reply 1')
    expect(html).toContain('Cached reply 9')
    const expanded = renderThreads(
      [cached],
      [{ threadId: 'thread', messageId: row(1).id }],
      'thread',
    )
    expect(expanded).toContain('Cached reply 1')
    expect(expanded).toContain(
      (language === 'en' ? en : ja)['comments.loadReplyGap'],
    )
    expect(expanded).not.toContain(
      language === 'en' ? 'Show 15 more replies' : '返信をあと15件表示',
    )
  },
)

function pagedThread(start: number, end: number): CommentThreadView {
  const at = '2026-05-01T00:00:00.000Z'
  const row = (i: number) => ({
    id: `message-${String(i).padStart(3, '0')}`,
    body: `Paged reply ${i}.`,
    createdAt: at,
    updatedAt: at,
    agent: null,
    author: {
      id: 'reviewer',
      name: 'Reviewer',
      email: 'reviewer@example.com',
      image: null,
    },
    canEdit: false,
    canDelete: false,
  })
  const cursor = (i: number) => messageCursor('thread', row(i))
  return {
    ...textThread('attached', 'thread'),
    messageCount: 301,
    replyCount: 300,
    olderCursor: cursor(start),
    messages: [
      0,
      ...Array.from({ length: end - start + 1 }, (_, i) => start + i),
      298,
      299,
      300,
    ].map(row),
    latestReplyIds: [298, 299, 300].map((i) => row(i).id),
    loadedPages: [
      { before: cursor(end + 1), limit: 50, coverageStart: cursor(start) },
    ],
  }
}

test('an around target displays all cached replies with the gap in chronological position', () => {
  const thread = pagedThread(100, 149)
  const html = renderThreads([thread], [], thread.id, 'all')
  expect(html.match(/Paged reply \d+\./g)).toHaveLength(54)
  expect(html).toContain('Paged reply 100.')
  expect(html).toContain('Show 247 more replies')
  const gap = html.indexOf(en['comments.loadReplyGap'])
  expect(gap).toBeGreaterThan(html.indexOf('Paged reply 149.'))
  expect(gap).toBeLessThan(html.indexOf('Paged reply 298.'))
})

test('expansion reveals cached replies without fetching and retains all 53 when the resolved target clears', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const thread = pagedThread(248, 297)
  const fetchPage = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ threads: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const panel = (target: boolean, resolved = false) => (
    <CommentPanel
      shareableId="artifact"
      viewerUserId="viewer"
      threads={[{ ...thread, status: resolved ? 'resolved' : 'open' }]}
      onThreadsChange={() => {}}
      isCurrentShareableId={() => true}
      open
      onOpenChange={() => {}}
      targetThreadId={target ? thread.id : null}
      requestedFilter="all"
      targetThreadScroll="center"
      onThreadNavigate={() => {}}
    />
  )
  const earlier = (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === label,
    )
    expect(button, host.textContent ?? label).toBeDefined()
    return button!
  }
  try {
    await act(async () => root.render(panel(false)))
    expect(host.textContent).not.toContain('Paged reply 248.')
    await act(async () => earlier('Show 297 earlier replies').click())
    expect(fetchPage).not.toHaveBeenCalled()
    expect(host.textContent?.match(/Paged reply \d+\./g)).toHaveLength(54)
    await act(async () => root.render(panel(true)))
    await act(async () => root.render(panel(false, true)))
    expect(host.textContent?.match(/Paged reply \d+\./g)).toHaveLength(54)
    expect(host.textContent).toContain('Paged reply 248.')
    await act(async () => earlier('Show 247 earlier replies').click())
    expect(fetchPage).toHaveBeenCalledTimes(1)
    const url = new URL(
      String(fetchPage.mock.calls[0][0]),
      'https://example.com',
    )
    expect(url.searchParams.get('before')).toBe(thread.olderCursor)
    expect(url.searchParams.get('limit')).toBe('50')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    fetchPage.mockRestore()
    vi.unstubAllGlobals()
  }
})

test('a deleted unread target advances to the next surviving unloaded reply without retry guidance', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const history = pagedThread(70, 70)
  const initial = {
    ...history,
    messages: history.messages.filter((row) => row.id !== 'message-070'),
    loadedPages: undefined,
  }
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = new URL(String(input), 'https://example.com')
      if (url.searchParams.get('around_message_id') === 'message-010')
        return Response.json({}, { status: 404 })
      if (url.searchParams.get('around_message_id') === 'message-070')
        return Response.json({
          threads: [history],
          page: { through: messageCursor('thread', history.messages[1]) },
        })
      return Response.json({ threads: [initial] })
    })
  function Harness() {
    const [thread, setThread] = useState<CommentThreadView>(initial)
    return (
      <CommentPanel
        shareableId="artifact"
        viewerUserId="viewer"
        threads={[thread]}
        newCommentMessages={[10, 70].map((id) => ({
          threadId: 'thread',
          messageId: `message-${String(id).padStart(3, '0')}`,
        }))}
        onThreadsChange={(rows) =>
          setThread((current) => mergeCommentWindow(current, rows[0]))
        }
        isCurrentShareableId={() => true}
        open
        onOpenChange={() => {}}
        targetThreadId="thread"
        requestedFilter="all"
        targetThreadScroll="center"
        onThreadNavigate={() => {}}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Harness />))
    await waitForRealTaskCondition(async () => {
      await act(async () => {})
      return host.textContent?.includes('Paged reply 70.') === true
    }, 'next unread reply displayed')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(host.textContent).not.toContain(en['comments.errorReplies'])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    fetch.mockRestore()
    vi.unstubAllGlobals()
  }
})

test.each([100, 201])(
  'an unread entry starting at %i loads only the first unread page even when the tail is unread',
  async (firstUnread) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const history = pagedThread(firstUnread, firstUnread + 49)
    const initial = {
      ...history,
      messages: history.messages.filter((row) =>
        ['message-000', 'message-298', 'message-299', 'message-300'].includes(
          row.id,
        ),
      ),
      loadedPages: undefined,
    }
    const fetchPage = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input), 'https://example.com')
        const start = Number(
          url.searchParams.get('around_message_id')?.split('-')[1],
        )
        const page = pagedThread(start, start + 49)
        return Response.json({
          threads: [page],
          page: { through: messageCursor('thread', page.messages[50]) },
        })
      })
    function Harness() {
      const [thread, setThread] = useState<CommentThreadView>(initial)
      return (
        <CommentPanel
          shareableId="synthetic-artifact"
          viewerUserId="viewer"
          threads={[thread]}
          newCommentMessages={Array.from({ length: 100 }, (_, i) => ({
            threadId: 'thread',
            messageId: `message-${firstUnread + i}`,
          }))}
          onThreadsChange={(rows, patch) =>
            setThread((current) =>
              mergeCommentWindow(current, rows[0], patch?.page),
            )
          }
          isCurrentShareableId={() => true}
          open
          onOpenChange={() => {}}
          targetThreadId="thread"
          requestedFilter="all"
          targetThreadScroll="center"
          onThreadNavigate={() => {}}
        />
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Harness />))
      await waitForRealTaskCondition(async () => {
        await act(async () => {})
        return (
          host.textContent?.includes(`Paged reply ${firstUnread + 49}.`) ===
          true
        )
      }, 'first unread page displayed')
      expect(fetchPage).toHaveBeenCalledTimes(1)
      const url = new URL(
        String(fetchPage.mock.calls[0][0]),
        'https://example.com',
      )
      expect(url.searchParams.get('around_message_id')).toBe(
        `message-${firstUnread}`,
      )
      expect(url.searchParams.get('limit')).toBe('50')
      expect(host.textContent).toContain(`Paged reply ${firstUnread}.`)
      expect(host.textContent).not.toContain(`Paged reply ${firstUnread + 50}.`)
      const gaps = Array.from(host.querySelectorAll('button')).filter(
        (button) => button.textContent === en['comments.loadReplyGap'],
      )
      expect(gaps).toHaveLength(1)
      expect(
        host.textContent!.indexOf(en['comments.loadReplyGap']),
      ).toBeGreaterThan(
        host.textContent!.indexOf(`Paged reply ${firstUnread + 49}.`),
      )
      expect(
        host.textContent!.indexOf(en['comments.loadReplyGap']),
      ).toBeLessThan(host.textContent!.indexOf('Paged reply 298.'))
    } finally {
      await act(async () => root.unmount())
      host.remove()
      fetchPage.mockRestore()
      vi.unstubAllGlobals()
    }
  },
)

test('a failed interior gap keeps the older control normal and retries the same gap', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = pagedThread(100, 149)
  const fetchPage = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ threads: [pagedThread(248, 297)] }))
  function Harness() {
    const [thread, setThread] = useState(initial)
    return (
      <CommentPanel
        shareableId="synthetic-artifact"
        viewerUserId="viewer"
        threads={[thread]}
        onThreadsChange={(rows, patch) =>
          setThread((current) =>
            mergeCommentWindow(current, rows[0], patch?.page),
          )
        }
        isCurrentShareableId={() => true}
        open
        onOpenChange={() => {}}
        targetThreadId="thread"
        requestedFilter="all"
        targetThreadScroll="center"
        onThreadNavigate={() => {}}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === label,
    )
    expect(found, host.textContent ?? label).toBeDefined()
    return found!
  }
  const settled = (key: 'comments.errorReplies' | 'comments.errorGapReplies') =>
    waitForRealTaskCondition(async () => {
      await act(async () => {})
      return host.textContent?.includes(en[key]) === true
    }, 'failed reply request displayed')
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => button(en['comments.loadReplyGap']).click())
    await settled('comments.errorGapReplies')
    expect(host.textContent).not.toContain(en['comments.errorReplies'])
    const status = host.querySelector('[role="status"]')!
    expect(status.textContent).toBe(en['comments.errorGapReplies'])
    expect(status.nextElementSibling).toBe(button(en['comments.loadReplyGap']))
    expect(
      host.textContent!.indexOf(en['comments.errorGapReplies']),
    ).toBeGreaterThan(host.textContent!.indexOf('Paged reply 149.'))
    expect(host.textContent).not.toContain(en['comments.retryReplies'])
    const failedGap = String(fetchPage.mock.calls[0][0])
    expect(
      new URL(failedGap, 'https://example.com').searchParams.get('before'),
    ).not.toBe(initial.olderCursor)
    await act(async () => button('Show 247 more replies').click())
    await settled('comments.errorReplies')
    const older = new URL(
      String(fetchPage.mock.calls[1][0]),
      'https://example.com',
    )
    expect(older.searchParams.get('before')).toBe(initial.olderCursor)
    expect(older.searchParams.get('limit')).toBe('50')
    await act(async () => button(en['comments.loadReplyGap']).click())
    await waitForRealTaskCondition(async () => {
      await act(async () => {})
      return host.textContent?.includes('Paged reply 248.') === true
    }, 'gap replies recovered')
    expect(String(fetchPage.mock.calls[2][0])).toBe(failedGap)
    expect(host.textContent!.indexOf('Paged reply 149.')).toBeLessThan(
      host.textContent!.indexOf('Paged reply 248.'),
    )
    expect(host.textContent!.indexOf('Paged reply 297.')).toBeLessThan(
      host.textContent!.indexOf('Paged reply 298.'),
    )
    expect(host.textContent).not.toContain(en['comments.errorReplies'])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    fetchPage.mockRestore()
    vi.unstubAllGlobals()
  }
})

test('a failed older page retains its normal expand label and offers an exact request retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = pagedThread(248, 297)
  let finish!: (response: Response) => void
  const fetchPage = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce(Response.json({ threads: [pagedThread(198, 247)] }))
  function Harness() {
    const [thread, setThread] = useState(initial)
    return (
      <CommentPanel
        shareableId="synthetic-artifact"
        viewerUserId="viewer"
        threads={[thread]}
        onThreadsChange={(rows, patch) =>
          setThread((current) =>
            mergeCommentWindow(current, rows[0], patch?.page),
          )
        }
        isCurrentShareableId={() => true}
        open
        onOpenChange={() => {}}
        targetThreadId="thread"
        requestedFilter="all"
        targetThreadScroll="center"
        onThreadNavigate={() => {}}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === label,
    )
    expect(found, host.textContent ?? label).toBeDefined()
    return found!
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => button('Show 247 earlier replies').click())
    expect(button(en['comments.loadingReplies']).disabled).toBe(true)
    expect(host.textContent).toContain('Paged reply 248.')
    finish(Response.json({}, { status: 503 }))
    await waitForRealTaskCondition(async () => {
      await act(async () => {})
      return host.textContent?.includes(en['comments.retryReplies']) === true
    }, 'older page retry displayed')
    const retry = button(en['comments.retryReplies'])
    expect(retry.getAttribute('data-variant')).toBe('outline')
    expect(retry.parentElement?.classList.contains('grid')).toBe(true)
    expect(retry.parentElement?.classList.contains('justify-items-start')).toBe(
      true,
    )
    expect(button('Show 247 earlier replies').disabled).toBe(false)
    expect(host.textContent).toContain('Paged reply 248.')
    await act(async () => button(en['comments.retryReplies']).click())
    await waitForRealTaskCondition(async () => {
      await act(async () => {})
      return host.textContent?.includes('Paged reply 198.') === true
    }, 'older page recovered')
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(String(fetchPage.mock.calls[1][0])).toBe(
      String(fetchPage.mock.calls[0][0]),
    )
    const requested = new URL(
      String(fetchPage.mock.calls[1][0]),
      'https://example.com',
    )
    expect(requested.searchParams.get('before')).toBe(initial.olderCursor)
    expect(requested.searchParams.get('limit')).toBe('50')
    expect(host.textContent).toContain('Paged reply 248.')
    expect(host.textContent).not.toContain(en['comments.retryReplies'])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    fetchPage.mockRestore()
    vi.unstubAllGlobals()
  }
})
