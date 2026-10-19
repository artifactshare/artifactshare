import { useCallback, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { toast, Toaster } from 'sonner'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentMessageView, CommentThreadView } from '~/lib/comments'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
import { InlineCommentPopover } from './a.$id/+components/inline-comment-popover'
import { CommentPanel } from './a.$id/+components/comment-panel'
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
function Harness({ showNewThreadComposer = true }) {
  const [threads, setThreads] = useState([initial])
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
        targetThreadId={null}
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
