import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentThreadView } from '~/lib/comments'
import {
  ViewerShell,
  type ViewerShellArtifact,
} from './a.$id/+components/viewer-shell'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
const at = '2026-05-01T00:00:00.000Z'
function thread(id: string): CommentThreadView {
  return {
    id,
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    canResolve: false,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [
      {
        id: `${id}-message`,
        body: `Content ${id}`,
        createdAt: at,
        updatedAt: at,
        agent: null,
        canEdit: false,
        canDelete: false,
        author: {
          id: 'reviewer',
          name: 'Reviewer',
          email: 'reviewer@example.com',
          image: null,
        },
      },
    ],
  }
}
const threads = Array.from({ length: 50 }, (_, i) => thread(`initial-${i}`))
const artifact: ViewerShellArtifact = {
  id: 'abc123def4',
  storageKey: 'abc123def4/index.html',
  name: 'Example',
  derivedTitle: null,
  titleOverride: null,
  ownerId: 'reviewer',
  ownerName: 'Reviewer',
  ownerEmail: 'reviewer@example.com',
  ownerImage: null,
  ownerInitial: 'R',
  modifiedTime: at,
  viewCount: 0,
  visibility: 'private',
  workspaceHd: null,
  availableVisibilities: ['private'],
  grants: [],
  comments: threads,
}
class UnavailableSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  send() {}
  close() {
    this.readyState = 3
  }
}
let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
async function mount(target = 'outside') {
  vi.stubGlobal('WebSocket', UnavailableSocket)
  router = createMemoryRouter(
    [
      {
        path: '/a/:id',
        element: (
          <TooltipProvider>
            <ViewerShell
              artifact={artifact}
              user={{
                id: 'reviewer',
                name: 'Reviewer',
                email: 'reviewer@example.com',
                image: null,
                initial: 'R',
              }}
              renderType="static_site"
              sandboxUrl={null}
              bundlePaths={[]}
            />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: [`/a/abc123def4?comment=${target}`] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() => expect(router!.state.location.search).toBe(''))
}
afterEach(() => {
  root?.unmount()
  router?.dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

test('outside-top50 target survives actual router URL cleanup without a socket opening', async () => {
  let resolve!: (response: Response) => void
  let signal: AbortSignal | undefined
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('thread_id=outside')) {
      signal = init?.signal ?? undefined
      return new Promise<Response>((done) => {
        resolve = done
      })
    }
    return Promise.resolve(Response.json({ threads }))
  })
  vi.stubGlobal('fetch', fetch)
  await mount()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  expect(signal?.aborted).toBe(false)
  resolve(Response.json({ threads: [thread('outside')] }))
  await expect
    .element(page.getByText('Content outside', { exact: true }))
    .toBeVisible()
  expect(router!.state.location.search).toBe('')
  expect(
    fetch.mock.calls.filter(([url]) =>
      String(url).includes('thread_id=outside'),
    ),
  ).toHaveLength(1)
})

test('a different navigation rejects the old slow target response and failed targets can retry', async () => {
  let resolveOld!: (response: Response) => void
  let oldSignal: AbortSignal | undefined
  let nextAttempts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('thread_id=outside')) {
        oldSignal = init?.signal ?? undefined
        return new Promise<Response>((done) => {
          resolveOld = done
        })
      }
      if (url.includes('thread_id=next')) {
        nextAttempts++
        return nextAttempts === 1
          ? Promise.reject(new TypeError('Synthetic offline'))
          : Promise.resolve(Response.json({ threads: [thread('next')] }))
      }
      return Promise.resolve(Response.json({ threads }))
    }),
  )
  await mount()
  await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'))
  await router!.navigate('/a/abc123def4?comment=next')
  expect(oldSignal?.aborted).toBe(false)
  resolveOld(Response.json({ threads: [thread('outside')] }))
  await expect
    .element(page.getByRole('button', { name: 'Retry comment refresh' }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Retry comment refresh' }).click()
  await expect
    .element(page.getByText('Content next', { exact: true }))
    .toBeVisible()
  expect(document.body.textContent).not.toContain('Content outside')
  expect(nextAttempts).toBe(2)
})
