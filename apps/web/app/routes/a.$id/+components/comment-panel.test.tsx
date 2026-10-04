import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
const locale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: locale.value,
    t: (key: keyof typeof en) => (locale.value === 'en' ? en : ja)[key],
    tPlural: () => 'comments',
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
    locale.value = 'en'
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
  expect(html).toContain('aria-label="New reaction in a resolved thread"')
  expect(html).toContain('tabindex="-1"')
  expect(html).toContain('data-new-comment-thread="true"')
  expect(html.match(/<article/g)).toHaveLength(51)
})
