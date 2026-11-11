import { settleCommentRuntimeMutation } from '~/test/comment-runtime-driver'
import { useCallback, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { toast, Toaster } from 'sonner'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentMessageView, CommentThreadView } from '~/lib/comments'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
import {
  hasPendingCommentMutation,
  useCommentMutations,
} from './a.$id/+components/use-comment-mutations'
import { TextSelectionCommentPopover } from './a.$id/+components/text-selection-comment-popover'
import { InlineCommentPopover } from './a.$id/+components/inline-comment-popover'
import { CommentPageSessionContext } from './a.$id/+components/use-comment-page'
import { CommentPanel } from './a.$id/+components/comment-panel'
import {
  useViewerComments,
  useSessionViewerComments,
} from './a.$id/+components/viewer-shell'
import {
  patchCommentThreads,
  type CommentThreadPatch,
} from './a.$id/+components/comment-history'

const locale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(locale.value) }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
const at = '2026-05-01T00:00:00.000Z'
const message = (i: number): CommentMessageView => ({
  id: `message-${i}`,
  body: `Review message ${i}`,
  createdAt: at,
  updatedAt: at,
  agent: null,
  author: {
    id: 'reviewer',
    name: 'Reviewer',
    email: 'reviewer@example.com',
    image: null,
  },
  canEdit: true,
  canDelete: true,
})
const olderCursor = btoa(
  JSON.stringify([1, 'thread', at, 'message-7']),
).replace(/=+$/, '')
const initial: CommentThreadView = {
  id: 'thread',
  status: 'open',
  subject: { kind: 'artifact' },
  createdAt: at,
  updatedAt: at,
  resolvedAt: null,
  canResolve: true,
  messageCount: 10,
  replyCount: 9,
  olderCursor,
  messages: [0, 7, 8, 9].map(message),
}
const older: CommentThreadView = {
  ...initial,
  olderCursor: null,
  messages: [0, 1, 2, 3, 4, 5, 6].map(message),
}
function Harness({
  showNewThreadComposer = true,
  initialThreads = [initial],
  selectedMessageId,
}: {
  showNewThreadComposer?: boolean
  initialThreads?: CommentThreadView[]
  selectedMessageId?: string
}) {
  const [threads, setThreads] = useState(initialThreads)
  const returnFocus = useRef<HTMLElement | null>(null)
  const change = useCallback(
    (incoming: ReadonlyArray<CommentThreadView>, patch?: CommentThreadPatch) =>
      setThreads((current) =>
        patchCommentThreads(current, incoming, patch ?? {}),
      ),
    [],
  )
  return (
    <TooltipProvider>
      <CommentPanel
        shareableId="synthetic-artifact"
        viewerUserId="reviewer"
        threads={threads}
        onThreadsChange={change}
        isCurrentShareableId={() => true}
        open
        showNewThreadComposer={showNewThreadComposer}
        onOpenChange={() => {}}
        targetThreadId={selectedMessageId ? 'thread' : null}
        newCommentMessages={
          selectedMessageId
            ? [{ threadId: 'thread', messageId: selectedMessageId }]
            : []
        }
        targetThreadScroll="start"
        focusTargetOnOpen={false}
        onTargetFocusConsumed={() => {}}
        onThreadNavigate={() => {}}
        returnFocusRef={returnFocus}
      />
      <Toaster />
    </TooltipProvider>
  )
}
let root: Root | undefined
let exitObserver: MutationObserver | undefined
async function mount(showNewThreadComposer = true) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Harness showNewThreadComposer={showNewThreadComposer} />)
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
}
afterEach(() => {
  vi.useRealTimers()
  exitObserver?.disconnect()
  exitObserver = undefined
  locale.value = 'en'
  toast.dismiss()
  root?.unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

test('pending and failed older pages retain replies and allow an actionable retry', async () => {
  let finish: ((response: Response) => void) | undefined
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce(Response.json({ threads: [older] }))
  vi.stubGlobal('fetch', fetch)
  await mount()
  await page.getByRole('button', { name: 'Show 6 earlier replies' }).click()
  await expect
    .element(page.getByRole('button', { name: 'Loading earlier replies…' }))
    .toBeDisabled()
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
  finish!(new Response(null, { status: 503 }))
  await expect
    .element(
      page.getByRole('button', { name: 'Retry loading earlier replies' }),
    )
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
  await page
    .getByRole('button', { name: 'Retry loading earlier replies' })
    .click()
  await expect
    .element(page.getByText('Review message 1', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
  expect(fetch).toHaveBeenCalledTimes(2)
  const requested = new URL(String(fetch.mock.calls[0][0]), location.origin)
  expect(requested.searchParams.get('thread_id')).toBe('thread')
  expect(requested.searchParams.get('before')).toBe(olderCursor)
  expect(requested.searchParams.get('limit')).toBe('50')
})

test.each([
  ['rate-limited', 429],
  ['thread-capacity', 409],
] as const)('%s preserves an unsent new-thread draft', async (code, status) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code, details: { retry_after_seconds: 12 } } },
          { status },
        ),
      ),
  )
  await mount()
  const draft = page.getByPlaceholder('Write a comment on the whole file')
  await draft.fill('Unsent review')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect
    .element(
      page.getByText(
        code === 'thread-capacity'
          ? en['comments.threadCapacityArtifact']
          : 'Posting limit reached. Retry in 12 seconds.',
      ),
    )
    .toBeVisible()
  await expect.element(draft).toHaveValue('Unsent review')
  await expect
    .element(page.getByRole('button', { name: 'Post', exact: true }))
    .toBeEnabled()
})

test('a failed comment retry stays visible when its prior notification is exiting', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: {} }, { status: 503 })),
  )
  let mutate: ReturnType<typeof useCommentMutations>['mutate'] | undefined
  function RetryHarness() {
    mutate = useCommentMutations({
      shareableId: 'retry-artifact',
      isCurrentShareableId: () => true,
      onThreadsChange: () => {},
    }).mutate
    return <Toaster duration={Infinity} />
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RetryHarness />)
  await vi.waitFor(() => expect(mutate).toBeTypeOf('function'))
  const payload = { intent: 'create-thread', body: 'Unsent review' } as const
  expect(await mutate!(payload)).toBe(false)
  await expect
    .element(page.getByText(en['comments.errorSave'], { exact: true }))
    .toBeVisible()
  const prior = host.querySelector<HTMLElement>('[data-sonner-toast]')!
  const priorToast = toast
    .getToasts()
    .find(
      (entry) => 'title' in entry && entry.title === en['comments.errorSave'],
    )!
  expect(priorToast).toBeDefined()
  // Hold Sonner's exit timeout while its real animation frames commit removal.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const removed = new Promise<void>((resolve) => {
      exitObserver = new MutationObserver(() => {
        if (prior.dataset.removed === 'true') {
          exitObserver!.disconnect()
          resolve()
        }
      })
      exitObserver.observe(prior, {
        attributes: true,
        attributeFilter: ['data-removed'],
      })
    })
    toast.dismiss(priorToast.id)
    await removed
    expect(prior.dataset.removed).toBe('true')
    expect(prior.isConnected).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(await mutate!(payload)).toBe(false)
    expect(prior.isConnected).toBe(true)
    // Run the queued error update and Sonner's 200ms exit lifecycle.
    await vi.advanceTimersByTimeAsync(200)
  } finally {
    exitObserver?.disconnect()
    exitObserver = undefined
    vi.useRealTimers()
  }
  await vi.waitFor(() => expect(prior.isConnected).toBe(false))
  await expect
    .element(page.getByText(en['comments.errorSave'], { exact: true }))
    .toBeVisible()
  const current = host.querySelector<HTMLElement>('[data-sonner-toast]')!
  expect(current).not.toBe(prior)
  expect(current.dataset.removed).toBe('false')
  expect(current.querySelector('[data-button]')).toBeNull()
})

test.each(['new-thread panel', 'text-selection popover'] as const)(
  'a held %s blocks repeat Enter and retains keyboard focus and draft after failure',
  async (surface) => {
    const finishes: Array<(response: Response) => void> = []
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finishes.push(resolve)
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const onClose = vi.fn()
    try {
      if (surface === 'new-thread panel') {
        await mount()
      } else {
        const host = document.createElement('div')
        document.body.appendChild(host)
        root = createRoot(host)
        root.render(
          <TooltipProvider>
            <TextSelectionCommentPopover
              shareableId="synthetic-artifact"
              anchor={{
                quotedText: 'Selected words',
                prefixText: '',
                suffixText: '',
                textStart: 0,
                textEnd: 14,
                cssPath: null,
                rect: { top: 100, left: 100, width: 100, height: 20 },
              }}
              isCurrentShareableId={() => true}
              onThreadsChange={() => {}}
              onClose={onClose}
            />
            <Toaster />
          </TooltipProvider>,
        )
      }
      const draft = page.getByRole('textbox', { name: en['comments.newLabel'] })
      await draft.fill('Retained new thread draft')
      await userEvent.keyboard('{Tab}')
      const submit = page.getByRole('button', {
        name: en[
          surface === 'new-thread panel' ? 'comments.post' : 'comments.comment'
        ],
        exact: true,
      })
      await expect.element(submit).toHaveFocus()
      const submitButton = document.activeElement
      await userEvent.keyboard('{Enter}')
      const sending = page.getByRole('button', {
        name: en['comments.sending'],
        exact: true,
      })
      await expect.element(sending).toHaveAttribute('aria-busy', 'true')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[0]).toBe(
        '/api/shareables/synthetic-artifact/comments',
      )
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
      const retainedPendingFocus = document.activeElement === submitButton
      await userEvent.keyboard('{Enter}')
      expect(fetch).toHaveBeenCalledTimes(1)
      for (const finish of finishes) finish(new Response(null, { status: 503 }))
      await expect.element(submit).not.toHaveAttribute('aria-busy')
      await expect.element(draft).toHaveValue('Retained new thread draft')
      await expect
        .element(page.getByText(en['comments.errorSave'], { exact: true }))
        .toBeVisible()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(onClose).not.toHaveBeenCalled()
      expect(
        retainedPendingFocus,
        'submit button keeps focus while POST is pending',
      ).toBe(true)
      await expect.element(submit).toHaveFocus()
      expect(document.activeElement).toBe(submitButton)
    } finally {
      // Drain every intercepted POST even when a baseline focus assertion fails.
      for (const finish of finishes) finish(new Response(null, { status: 503 }))
      await vi.waitFor(() =>
        expect(hasPendingCommentMutation('synthetic-artifact')).toBe(false),
      )
    }
  },
)

test('a held reply blocks repeat Enter and retains keyboard focus and draft after failure', async () => {
  let finish!: (response: Response) => void
  const fetch = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  vi.stubGlobal('fetch', fetch)
  await mount(false)
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const draft = page.getByRole('textbox', { name: 'Reply', exact: true })
  await draft.fill('Retained reply draft')
  await userEvent.keyboard('{Tab}{Tab}')
  const reply = page.getByRole('button', { name: 'Reply', exact: true })
  await expect.element(reply).toHaveFocus()
  const submitButton = document.activeElement
  await userEvent.keyboard('{Enter}')
  const sending = page.getByRole('button', {
    name: en['comments.sending'],
    exact: true,
  })
  await expect.element(sending).toHaveFocus()
  await expect.element(sending).toHaveAttribute('aria-busy', 'true')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  await userEvent.keyboard('{Enter}')
  expect(fetch).toHaveBeenCalledTimes(1)
  finish(new Response(null, { status: 503 }))
  await expect.element(reply).toHaveFocus()
  expect(document.activeElement).toBe(submitButton)
  await expect.element(draft).toHaveValue('Retained reply draft')
  await expect
    .element(page.getByText(en['comments.errorSave'], { exact: true }))
    .toBeVisible()
  await expect.element(reply).not.toHaveAttribute('aria-busy')
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each([
  ['en', false],
  ['en', true],
  ['ja', false],
  ['ja', true],
] as const)(
  'capacity recovery matches the %s composer context (%s)',
  async (language, showComposer) => {
    locale.value = language
    const copy = language === 'en' ? en : ja
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'thread-capacity' } },
            { status: 409 },
          ),
        ),
    )
    await mount(showComposer)
    await page
      .getByRole('button', { name: copy['comments.reply'], exact: true })
      .click()
    const draft = page.getByRole('textbox', {
      name: copy['comments.replyLabel'],
      exact: true,
    })
    await draft.fill('Unsent reply')
    await page
      .getByRole('button', { name: copy['comments.reply'], exact: true })
      .click()
    await expect
      .element(
        page.getByText(
          copy[
            showComposer
              ? 'comments.threadCapacityArtifact'
              : 'comments.threadCapacity'
          ],
          { exact: true },
        ),
      )
      .toBeVisible()
    await expect.element(draft).toHaveValue('Unsent reply')
  },
)

test.each(['en', 'ja'] as const)(
  'inline hidden replies open the conversation (%s)',
  async (language) => {
    locale.value = language
    const copy = language === 'en' ? en : ja
    const onOpenConversation = vi.fn()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <TooltipProvider>
        <InlineCommentPopover
          shareableId="synthetic-artifact"
          thread={initial}
          rect={{ top: 100, left: 100, width: 20, height: 10 }}
          isCurrentShareableId={() => true}
          onThreadsChange={() => {}}
          onClose={() => {}}
          onOpenConversation={onOpenConversation}
        />
      </TooltipProvider>,
    )
    await page
      .getByRole('button', {
        name: copy['comments.openConversationTitle'],
        exact: true,
      })
      .click()
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith('thread')
    expect(fetch).not.toHaveBeenCalled()
  },
)

test('disjoint target and latest ranges expose a bounded interior-gap action without dropping replies or drafts', async () => {
  const row = (i: number) => ({
    ...message(i),
    id: `message-${String(i).padStart(4, '0')}`,
  })
  const cursor = (i: number) =>
    btoa(JSON.stringify([1, 'thread', at, row(i).id])).replace(/=+$/, '')
  const tail = {
    ...initial,
    messageCount: 301,
    replyCount: 300,
    olderCursor: cursor(298),
    messages: [0, 298, 299, 300].map(row),
  }
  const requests: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://example.com')
      requests.push(url)
      const start = url.searchParams.has('around_message_id') ? 100 : 248
      return Response.json({
        threads: [
          {
            ...tail,
            olderCursor: cursor(start),
            messages: [
              row(0),
              ...Array.from({ length: 50 }, (_, i) => row(start + i)),
            ],
          },
        ],
        page: { through: cursor(start + 49) },
      })
    }),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <Harness initialThreads={[tail]} selectedMessageId={row(100).id} />,
  )
  await expect
    .element(page.getByText('Review message 100', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('button', { name: en['comments.loadReplyGap'] }))
    .toBeVisible()
  await page
    .getByRole('button', { name: en['comments.reply'], exact: true })
    .click()
  const draft = page.getByRole('textbox', { name: en['comments.replyLabel'] })
  await draft.fill('Keep this draft')
  await page.getByRole('button', { name: en['comments.loadReplyGap'] }).click()
  await expect
    .element(page.getByText('Review message 248', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 100', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 300', { exact: true }))
    .toBeVisible()
  await expect.element(draft).toHaveValue('Keep this draft')
  expect(requests).toHaveLength(2)
  expect(requests[1].searchParams.get('before')).toBe(cursor(298))
  expect(requests.every((url) => url.searchParams.get('limit') === '50')).toBe(
    true,
  )
  expect(
    page.getByText('Review message 298', { exact: true }).elements(),
  ).toHaveLength(1)
  await expect
    .element(page.getByRole('button', { name: en['comments.loadReplyGap'] }))
    .toBeVisible()
})

const otherThread: CommentThreadView = {
  ...initial,
  id: 'other',
  messages: [{ ...message(0), id: 'other-message', body: 'Other original' }],
  messageCount: 1,
  replyCount: 0,
  olderCursor: null,
}
const controllerThreads = [initial, otherThread]
test('a failed selected-message lookup offers retry and keeps the loaded tail', async () => {
  let attempts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new TypeError('Synthetic offline')
      return Response.json({
        threads: [older],
        page: { through: btoa(JSON.stringify([1, 'thread', at, 'message-6'])) },
      })
    }),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Harness selectedMessageId="message-4" />)
  await expect
    .element(
      page.getByRole('button', {
        name: en['comments.retryReplies'],
        exact: true,
      }),
    )
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
  await page
    .getByRole('button', { name: en['comments.retryReplies'], exact: true })
    .click()
  await expect
    .element(page.getByText('Review message 4', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
  expect(attempts).toBe(2)
})

test.each(['en', 'ja'] as const)(
  'collapsed cached replies use an accurate more-replies action (%s)',
  async (language) => {
    locale.value = language
    const copy = language === 'en' ? en : ja
    const cached: CommentThreadView = {
      ...initial,
      messageCount: 21,
      replyCount: 20,
      olderCursor: null,
      messages: [0, 1, 2, 7, 8, 9].map(message),
      latestReplyIds: [7, 8, 9].map((i) => message(i).id),
      loadedPages: [
        {
          through: btoa(JSON.stringify([1, 'thread', at, 'message-2'])),
          limit: 2,
          coverageStart: btoa(JSON.stringify([1, 'thread', at, 'message-1'])),
        },
      ],
    }
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<Harness initialThreads={[cached]} />)
    await expect
      .element(page.getByText('Review message 9', { exact: true }))
      .toBeVisible()
    const expand = page.getByRole('button', {
      name: copy['comments.moreReplyCountOther'].replace('{n}', '17'),
    })
    await expect.element(expand).toBeVisible()
    await expand.click()
    await expect
      .element(page.getByText('Review message 1', { exact: true }))
      .toBeVisible()
    await expect
      .element(
        page.getByRole('button', { name: copy['comments.loadReplyGap'] }),
      )
      .toBeVisible()
    await expect
      .element(
        page.getByRole('button', {
          name: copy['comments.moreReplyCountOther'].replace('{n}', '15'),
        }),
      )
      .not.toBeInTheDocument()
    root.render(<Harness key="reopened" initialThreads={[cached]} />)
    await expect.element(expand).toBeVisible()
    await expect
      .element(page.getByText('Review message 1', { exact: true }))
      .not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  },
)

describe.each([
  ['legacy', useViewerComments],
  ['session', useSessionViewerComments],
] as const)('comment pagination reconciliation (%s)', (_owner, useComments) => {
  function ReconciliationHarness() {
    const comments = useComments({
      artifactId: 'synthetic-artifact',
      currentUserId: 'reviewer',
      currentVersionId: null,
      initialThreads: controllerThreads,
      targetCommentId: 'thread',
      liveEnabled: false,
      framePresent: false,
    })
    return (
      <CommentPageSessionContext value={comments.pageSession}>
        <TooltipProvider>
          <CommentPanel
            shareableId="synthetic-artifact"
            viewerUserId="reviewer"
            threads={comments.panelThreads}
            onThreadsChange={comments.replaceThreads}
            isCurrentShareableId={comments.isCurrentArtifactId}
            open
            onOpenChange={comments.changePanelOpen}
            targetThreadId={comments.state.targetThreadId}
            targetThreadScroll="start"
            targetFetchFailed={comments.targetFetchFailed}
            onRetryTarget={comments.retryTargetFetch}
            onThreadNavigate={(thread) => comments.targetThread(thread.id)}
          />
        </TooltipProvider>
      </CommentPageSessionContext>
    )
  }
  async function mountReconciliation() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<ReconciliationHarness />)
    await expect
      .element(page.getByText('Review message 9', { exact: true }))
      .toBeVisible()
  }
  function requestReconciliation(threadId = 'other') {
    settleCommentRuntimeMutation({
      shareableId: 'synthetic-artifact',
      threadId,
      clientMutationId: 'synthetic-mutation',
      appliedThreads: true,
      requiresReconcile: true,
    })
  }
  const otherUpdated = {
    ...otherThread,
    messages: [{ ...otherThread.messages[0], body: 'Other updated' }],
  }

  test.each(['selected read', 'loaded range'])(
    '%s failure preserves drafts and independent updates; explicit retry removes a remote deletion',
    async (mode) => {
      let failing = false
      let deleted = false
      let rangeReads = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), 'https://example.com')
          if (url.searchParams.has('before')) {
            rangeReads++
            if (failing) throw new TypeError('Synthetic offline')
            return Response.json({
              threads: [
                {
                  ...older,
                  messages: older.messages.filter(
                    (row) => !deleted || row.id !== 'message-1',
                  ),
                },
              ],
            })
          }
          if (url.searchParams.has('thread_id')) {
            if (failing) throw new TypeError('Synthetic offline')
            return Response.json({ threads: [initial] })
          }
          return Response.json({
            threads: [
              otherUpdated,
              ...(mode === 'loaded range' ? [initial] : []),
            ],
          })
        }),
      )
      await mountReconciliation()
      await page.getByRole('button', { name: 'Show 6 earlier replies' }).click()
      await expect
        .element(page.getByText('Review message 1', { exact: true }))
        .toBeVisible()
      const card = page
        .getByRole('article')
        .filter({ hasText: 'Review message 9' })
      await card.getByRole('button', { name: 'Reply', exact: true }).click()
      const draft = card.getByRole('textbox', { name: 'Reply', exact: true })
      await draft.fill('Retained draft')
      failing = true
      requestReconciliation('thread')
      await expect
        .element(page.getByText('Other updated', { exact: true }))
        .toBeVisible()
      await expect
        .element(page.getByText('Review message 1', { exact: true }))
        .toBeVisible()
      await expect.element(draft).toHaveValue('Retained draft')
      await expect
        .element(page.getByRole('button', { name: 'Retry comment refresh' }))
        .toBeVisible()
      failing = false
      deleted = true
      const previousReads = rangeReads
      await page.getByRole('button', { name: 'Retry comment refresh' }).click()
      await expect
        .element(page.getByText('Review message 1', { exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('button', { name: 'Retry comment refresh' }))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByText('Review message 2', { exact: true }))
        .toBeVisible()
      await expect.element(draft).toHaveValue('Retained draft')
      expect(rangeReads).toBeGreaterThan(previousReads)
    },
  )

  test('an older page winning reconciliation retains the draft and still applies another thread update', async () => {
    let resolveList!: (value: Response) => void
    let listCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://example.com')
        if (url.searchParams.has('before'))
          return Response.json({ threads: [older] })
        listCalls++
        if (listCalls === 1)
          return new Promise<Response>((done) => {
            resolveList = done
          })
        return Response.json({ threads: [initial, otherUpdated] })
      }),
    )
    await mountReconciliation()
    const card = page
      .getByRole('article')
      .filter({ hasText: 'Review message 9' })
    await card.getByRole('button', { name: 'Reply', exact: true }).click()
    await card
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Retained draft')
    requestReconciliation()
    await vi.waitFor(() => expect(listCalls).toBe(1))
    await page.getByRole('button', { name: 'Show 6 earlier replies' }).click()
    await expect
      .element(page.getByText('Review message 1', { exact: true }))
      .toBeVisible()
    resolveList(Response.json({ threads: controllerThreads }))
    await expect
      .element(page.getByText('Other updated', { exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByText('Review message 1', { exact: true }))
      .toBeVisible()
    await expect
      .element(card.getByRole('textbox', { name: 'Reply', exact: true }))
      .toHaveValue('Retained draft')
    expect(listCalls).toBe(2)
  })

  test.each([401, 403])(
    'range %i recovers authorization without unmounting the reply draft',
    async (status) => {
      let recovering = false
      let refused = false
      let finishRecovery!: (response: Response) => void
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://example.com')
        if (url.searchParams.has('before')) {
          if (recovering && !refused) {
            refused = true
            return new Response(null, { status })
          }
          return Response.json({ threads: [older] })
        }
        if (refused)
          return new Promise<Response>((resolve) => {
            finishRecovery = resolve
          })
        return Response.json({ threads: controllerThreads })
      })
      vi.stubGlobal('fetch', fetch)
      await mountReconciliation()
      await page.getByRole('button', { name: 'Show 6 earlier replies' }).click()
      await expect
        .element(page.getByText('Review message 1', { exact: true }))
        .toBeVisible()
      const card = page
        .getByRole('article')
        .filter({ hasText: 'Review message 9' })
      await card.getByRole('button', { name: 'Reply', exact: true }).click()
      const draft = card.getByRole('textbox', { name: 'Reply', exact: true })
      await draft.fill('Retained authorization draft')
      recovering = true
      requestReconciliation('thread')
      await vi.waitFor(() => expect(finishRecovery).toBeTypeOf('function'), {
        timeout: 5000,
      })
      await expect
        .element(page.getByText('Review message 1', { exact: true }))
        .toBeVisible()
      await expect.element(draft).toHaveValue('Retained authorization draft')
      finishRecovery(Response.json({ threads: [initial, otherUpdated] }))
      await expect
        .element(page.getByText('Other updated', { exact: true }))
        .toBeVisible()
      await expect.element(draft).toHaveValue('Retained authorization draft')
    },
  )
})
