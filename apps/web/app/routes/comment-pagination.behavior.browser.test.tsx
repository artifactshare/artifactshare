import { useCallback, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { toast, Toaster } from 'sonner'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentMessageView, CommentThreadView } from '~/lib/comments'
import { CommentPanel } from './a.$id/+components/comment-panel'
import {
  patchCommentThreads,
  type CommentThreadPatch,
} from './a.$id/+components/comment-history'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
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
function Harness() {
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
        showNewThreadComposer
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
async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Harness />)
  await expect
    .element(page.getByText('Review message 9', { exact: true }))
    .toBeVisible()
}
afterEach(() => {
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
          ? 'This thread has 500 messages. Start a new thread.'
          : 'Posting limit reached. Retry in 12 seconds.',
      ),
    )
    .toBeVisible()
  await expect.element(draft).toHaveValue('Unsent review')
  await expect
    .element(page.getByRole('button', { name: 'Post', exact: true }))
    .toBeEnabled()
})
