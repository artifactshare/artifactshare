import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentThreadView } from '~/lib/comments'
import type { ViewerRevisitContext } from '~/lib/viewer-revisit'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { CommentPanel } from './+components/comment-panel'
import { VersionWidget } from './+components/version-widget'
import { useViewerComments } from './+components/viewer-shell'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

const time = '2026-01-03T00:00:00.000Z'
const textSubject: Extract<CommentThreadView['subject'], { kind: 'text' }> = {
  kind: 'text',
  state: 'attached',
  positionState: 'attached',
  quotedText: 'Review this section',
  prefixText: '',
  suffixText: '',
  targetPath: '/index.html',
  versionId: 'v1',
  textStart: null,
  textEnd: null,
  cssPath: null,
}
function thread(
  id: string,
  subject: CommentThreadView['subject'],
  status: 'open' | 'resolved' = 'open',
  count = 1,
): CommentThreadView {
  return {
    id,
    subject,
    status,
    createdAt: time,
    updatedAt: time,
    resolvedAt: status === 'resolved' ? time : null,
    canResolve: false,
    messages: Array.from({ length: count }, (_, index) => ({
      id: `${id}-message-${index}`,
      body: `${id} message ${index}`,
      agent: null,
      createdAt: time,
      updatedAt: time,
      author: {
        id: index === 0 ? 'u2' : 'u1',
        name: 'Reviewer',
        email: 'reviewer@example.com',
        image: null,
      },
      canEdit: false,
      canDelete: false,
    })),
  }
}
function entryFixture(kind: 'artifact' | 'resolved' | 'orphaned') {
  const target = thread(
    'thread-first',
    kind === 'orphaned'
      ? { ...textSubject, state: 'orphaned', positionState: 'needs-check' }
      : { kind: 'artifact' },
    kind === 'resolved' ? 'resolved' : 'open',
    2,
  )
  const later = thread('thread-last', {
    ...textSubject,
    state: 'orphaned',
    positionState: 'needs-check',
  })
  const threads = [
    later,
    ...Array.from({ length: 10 }, (_, index) =>
      thread(`old-${index}`, textSubject),
    ),
    target,
  ]
  const context: ViewerRevisitContext = {
    entryCurrentVersionId: 'v1',
    version: null,
    commentCount: 2,
    newCommentMessages: [
      { messageId: 'thread-last-message-0', threadId: 'thread-last' },
      { messageId: 'thread-first-message-0', threadId: 'thread-first' },
    ],
  }
  return { threads, context }
}

function Harness({
  threads,
  context: entry,
  artifactId = 'abc123def4',
  targetCommentId = null,
  navigationThreadId,
}: {
  threads: CommentThreadView[]
  context: ViewerRevisitContext
  artifactId?: string
  targetCommentId?: string | null
  navigationThreadId?: string
}) {
  const [context, setContext] = useState(entry)
  const [updates, setUpdates] = useState(0)
  const comments = useViewerComments({
    framePresent: true,
    artifactId,
    currentUserId: 'u1',
    currentVersionId: 'v1',
    initialThreads: threads,
    targetCommentId,
    liveEnabled: false,
  })
  return (
    <TooltipProvider>
      <header
        id="viewer-topbar"
        className="bg-background min-h-topbar-expanded flex items-center"
      >
        <button onClick={(event) => comments.openPanel(event.currentTarget)}>
          Comments
        </button>
        {navigationThreadId ? (
          <button
            onClick={() =>
              comments.targetThread(navigationThreadId, { scroll: 'center' })
            }
          >
            Navigate to thread
          </button>
        ) : null}
        <button onClick={() => setUpdates((value) => value + 1)}>
          Update {updates}
        </button>
        <button
          onClick={() =>
            setContext({
              ...entry,
              version: { kind: 'fallback' },
              commentCount: 0,
              newCommentMessages: [],
            })
          }
        >
          Revisit
        </button>
      </header>
      <VersionWidget
        versions={[
          {
            id: 'v1',
            ordinal: 1,
            createdAt: time,
            sizeBytes: 1,
            isCurrent: true,
          },
        ]}
        onOpenHistory={() => {}}
        revisitContext={context}
        onCommentsOpen={comments.openPanel}
      />
      <output
        data-target={comments.state.targetThreadId ?? ''}
        data-target-scroll={comments.state.targetThreadScroll}
        data-focus-request={String(comments.focusTargetOnOpen)}
      />
      <CommentPanel
        key={artifactId}
        shareableId={artifactId}
        viewerUserId="u1"
        threads={comments.panelThreads}
        onThreadsChange={comments.replaceThreads}
        isCurrentShareableId={comments.isCurrentArtifactId}
        open={comments.state.panelOpen}
        onOpenChange={comments.changePanelOpen}
        targetThreadId={comments.state.targetThreadId}
        targetThreadScroll={comments.state.targetThreadScroll}
        requestedFilter={comments.requestedFilter}
        focusTargetOnOpen={comments.focusTargetOnOpen}
        onTargetFocusConsumed={comments.consumeTargetFocus}
        newCommentMessages={context.newCommentMessages}
        onThreadNavigate={(item) => comments.targetThread(item.id)}
        returnFocusRef={comments.returnFocusRef}
      />
    </TooltipProvider>
  )
}
let root: Root | undefined
let host: HTMLDivElement
async function mount(fixture: Parameters<typeof Harness>[0]) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Harness {...fixture} />)
  await vi.waitFor(() =>
    expect(document.querySelector('[data-revisit-comments]')).not.toBeNull(),
  )
}
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
})

for (const width of [390, 1280]) {
  test.each(['artifact', 'resolved', 'orphaned'] as const)(
    `count opens all, scrolls and focuses the first marked %s card at ${width}px`,
    async (kind) => {
      await page.viewport(width, 800)
      await mount(entryFixture(kind))
      await userEvent.click(
        document.querySelector<HTMLButtonElement>('[data-revisit-comments]')!,
      )
      const target = () => document.getElementById('comment-card-thread-first')!
      await vi.waitFor(() => expect(document.activeElement).toBe(target()))
      await Promise.all(
        document
          .querySelector('[data-slot="sheet-content"]')!
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      )
      await waitForBrowserLayout()
      expect(document.activeElement).toBe(target())
      expect(document.querySelector('[data-revisit-comments]')).toBeNull()
      await expect
        .element(page.getByRole('tab', { name: 'All', exact: true }))
        .toHaveAttribute('aria-selected', 'true')
      expect(document.querySelector('output')?.dataset.target).toBe(
        'thread-first',
      )
      expect(document.querySelector('output')?.dataset.focusRequest).toBe(
        'false',
      )
      const scroller = target().parentElement!
      expect(scroller.scrollTop).toBeGreaterThan(0)
      const cardRect = target().getBoundingClientRect()
      const listRect = scroller.getBoundingClientRect()
      expect(cardRect.top).toBeGreaterThanOrEqual(listRect.top)
      expect(cardRect.top).toBeLessThan(listRect.bottom)
      const label = target().querySelector(
        '[data-comment-message-meta]',
      )!.firstElementChild!
      const labelRect = label.getBoundingClientRect()
      expect(label.textContent).toBe('New')
      expect(labelRect.top).toBeGreaterThanOrEqual(listRect.top)
      expect(labelRect.bottom).toBeLessThanOrEqual(listRect.bottom)
      expect(
        target().querySelector('[data-new-comment-message]')?.textContent,
      ).toContain('New')
      expect(
        target().querySelectorAll('[data-new-comment-message]'),
      ).toHaveLength(1)
      expect(
        document
          .getElementById('comment-card-old-0')
          ?.hasAttribute('data-new-comment-thread'),
      ).toBe(false)
      expect(target().scrollWidth).toBeLessThanOrEqual(target().clientWidth)

      // Changes unrelated to this entry request must leave focus with the user.
      // Establish keyboard focus explicitly; mouse clicks need not focus buttons.
      const updateButton = page
        .getByRole('button', { name: 'Update 0', exact: true })
        .element() as HTMLButtonElement
      updateButton.focus()
      expect(document.activeElement).toBe(updateButton)
      await userEvent.keyboard('{Enter}')
      await waitForBrowserLayout()
      expect(updateButton.textContent).toBe('Update 1')
      expect(document.activeElement).toBe(updateButton)
      await userEvent.click(
        page.getByRole('button', { name: 'Close', exact: true }),
      )
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute('aria-label')).toBe(
          'Version status: v1',
        ),
      )
      await userEvent.click(
        page.getByRole('button', { name: 'Comments', exact: true }),
      )
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-new-comment-thread]'),
        ).not.toBeNull(),
      )
      await waitForBrowserLayout()
      expect(document.querySelector('output')?.dataset.target).toBe('')
      expect(document.activeElement).not.toBe(target())
      expect(document.querySelector('[data-revisit-comments]')).toBeNull()
      expect(
        document.querySelectorAll('[data-new-comment-message]'),
      ).toHaveLength(kind === 'resolved' ? 1 : 2)
      await userEvent.click(
        page.getByRole('button', { name: 'Revisit', exact: true }),
      )
      await vi.waitFor(() =>
        expect(document.querySelector('[data-new-comment-thread]')).toBeNull(),
      )
      expect(document.querySelector('[data-new-comment-message]')).toBeNull()
      expect(document.querySelector('[data-revisit-comments]')).toBeNull()
      await expect
        .element(
          page.getByRole('button', {
            name: 'Version updated since last visit',
            exact: true,
          }),
        )
        .toBeVisible()
    },
  )
}

test('deleted message pairs open all without a stale target', async () => {
  const fixture = entryFixture('resolved')
  fixture.context.newCommentMessages = [
    { threadId: 'thread-first', messageId: 'deleted-message' },
  ]
  await mount(fixture)
  await userEvent.click(
    document.querySelector<HTMLButtonElement>('[data-revisit-comments]')!,
  )
  await expect
    .element(page.getByRole('tab', { name: 'All', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  expect(document.querySelector('output')?.dataset.target).toBe('')
  expect(document.querySelector('[data-new-comment-thread]')).toBeNull()
})

test('a count clicked after closing the panel focuses once and switching files clears the request', async () => {
  const fixture = entryFixture('artifact')
  await mount(fixture)
  await userEvent.click(
    page.getByRole('button', { name: 'Comments', exact: true }),
  )
  await expect
    .element(page.getByRole('tab', { name: 'Open', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  // Wait for the sheet to close before clicking the count hint underneath it.
  await userEvent.click(
    page.getByRole('button', { name: 'Close', exact: true }),
  )
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull(),
  )
  await userEvent.click(
    document.querySelector<HTMLButtonElement>('[data-revisit-comments]')!,
  )
  await vi.waitFor(() =>
    expect(document.activeElement?.id).toBe('comment-card-thread-first'),
  )
  expect(document.querySelector('output')?.dataset.focusRequest).toBe('false')
  root!.render(<Harness {...fixture} artifactId="abc123def5" />)
  await vi.waitFor(() =>
    expect(document.querySelector('output')?.dataset.target).toBe(''),
  )
  expect(document.querySelector('output')?.dataset.focusRequest).toBe('false')
})

test.each(['deep-link', 'anchor-navigation'] as const)(
  'ordinary Comments preserves a paginated resolved %s target',
  async (source) => {
    await page.viewport(1280, 800)
    const fixture = entryFixture('resolved')
    const target = thread('thread-target', { kind: 'artifact' }, 'resolved')
    fixture.threads = [
      ...Array.from({ length: 50 }, (_, index) =>
        thread(`resolved-${index}`, textSubject, 'resolved'),
      ),
      target,
    ]
    await mount({
      ...fixture,
      targetCommentId: source === 'deep-link' ? target.id : null,
      navigationThreadId: target.id,
    })
    if (source === 'anchor-navigation')
      await userEvent.click(
        page.getByRole('button', { name: 'Navigate to thread', exact: true }),
      )
    await expect
      .element(page.getByRole('tab', { name: 'Resolved', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    const card = document.getElementById('comment-card-thread-target')!
    expect(card).not.toBeNull()
    expect(document.querySelectorAll('article')).toHaveLength(51)
    expect(card.classList.contains('ring-3')).toBe(true)

    // Keyboard activation makes retained focus independent of mouse-focus policy.
    const commentsButton = page
      .getByRole('button', { name: 'Comments', exact: true })
      .element() as HTMLButtonElement
    commentsButton.focus()
    expect(document.activeElement).toBe(commentsButton)
    await userEvent.keyboard('{Enter}')
    await waitForBrowserLayout()
    expect(document.querySelector('output')?.dataset.target).toBe(target.id)
    expect(document.querySelector('output')?.dataset.targetScroll).toBe(
      source === 'deep-link' ? 'start' : 'center',
    )
    await expect
      .element(page.getByRole('tab', { name: 'Resolved', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    expect(document.getElementById(card.id)).toBe(card)
    expect(card.classList.contains('ring-3')).toBe(true)
    expect(document.querySelectorAll('article')).toHaveLength(51)
    expect(document.activeElement).toBe(commentsButton)
    expect(document.querySelector('output')?.dataset.focusRequest).toBe('false')

    // Close the sheet so the count hint is reachable, then reopen with a
    // request containing only messages that have since been removed.
    await userEvent.click(
      page.getByRole('button', { name: 'Close', exact: true }),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull(),
    )
    await userEvent.click(
      document.querySelector<HTMLButtonElement>('[data-revisit-comments]')!,
    )
    await expect
      .element(page.getByRole('tab', { name: 'All', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('output')?.dataset.target).toBe('')
    expect(document.getElementById(card.id)).toBeNull()
  },
)
