import { StrictMode, Suspense, act, startTransition } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
  useParams,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { commentFixture } from '~/test/comment-fixtures'
import {
  ViewerShell,
  useViewerComments,
  type ViewerShellArtifact,
} from './a.$id/+components/viewer-shell'
import { hasPendingCommentMutation } from './a.$id/+components/use-comment-mutations'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

class WaitingSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  static instances: WaitingSocket[] = []
  readyState = 0
  readonly url: string
  constructor(url: string | URL) {
    super()
    this.url = String(url)
    WaitingSocket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const base = commentFixture('thread', 'Original comment')
const message = (index: number) => ({
  ...base.messages[0],
  id: `message-${index}`,
  body: `Reply ${index}`,
})
const before = btoa(
  JSON.stringify([1, 'thread', base.createdAt, 'message-4']),
).replace(/=+$/, '')
const tail = {
  ...base,
  messageCount: 6,
  replyCount: 5,
  olderCursor: before,
  messages: [base.messages[0], message(4), message(5)],
}
const older = {
  ...tail,
  olderCursor: null,
  messages: [base.messages[0], message(1), message(2), message(3)],
}
const posted = {
  ...tail,
  messageCount: 7,
  replyCount: 6,
  messages: [
    ...tail.messages,
    { ...message(6), body: 'Posted across navigation' },
  ],
}
const shell: ViewerShellArtifact = {
  id: 'a',
  storageKey: 'a/index.html',
  name: 'Comment synchronization fixture',
  derivedTitle: null,
  titleOverride: null,
  ownerId: 'reviewer',
  ownerName: 'Reviewer',
  ownerEmail: 'reviewer@example.com',
  ownerImage: null,
  ownerInitial: 'R',
  modifiedTime: base.createdAt,
  viewCount: 0,
  visibility: 'private',
  workspaceHd: null,
  availableVisibilities: ['private'],
  grants: [],
  comments: [tail],
}
const user = {
  id: 'reviewer',
  name: 'Reviewer',
  email: 'reviewer@example.com',
  image: null,
  initial: 'R',
}

test('real panel preserves history during revalidation and posts across navigation once', async () => {
  let version = 'v1'
  const trace: string[] = []
  const events: Array<Record<string, unknown>> = []
  const log = vi.spyOn(console, 'info').mockImplementation((name, event) => {
    if (
      name === 'artifactshare_viewer_network' &&
      event.channel === 'comment-sync'
    )
      events.push(event)
  })
  let finishPost: ((response: Response) => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.origin)
      trace.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/versions'))
        return Promise.resolve(
          Response.json({ versions: [], currentVersionId: version }),
        )
      if (init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          finishPost = resolve
        })
      if (url.searchParams.has('before'))
        return Promise.resolve(Response.json({ threads: [older] }))
      return Promise.resolve(Response.json({}, { status: 503 }))
    }),
  )
  WaitingSocket.instances = []
  vi.stubGlobal('WebSocket', WaitingSocket)
  function Route() {
    const { id } = useParams()
    const data = useLoaderData<{
      version: string
    }>()
    return (
      <TooltipProvider>
        <ViewerShell
          artifact={{
            ...shell,
            id: id!,
            comments:
              id === 'a' ? [tail] : [commentFixture('b-only', 'B original')],
            currentVersionId: data.version,
          }}
          user={user}
          renderType="html"
          sandboxUrl={null}
          bundlePaths={[]}
        />
      </TooltipProvider>
    )
  }
  const router = createMemoryRouter(
    [
      {
        path: '/a/:id',
        loader: () => ({ version }),
        Component: Route,
      },
    ],
    { initialEntries: ['/a/a?comment=thread'] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    root.render(<RouterProvider router={router} />)
    await expect
      .element(page.getByText('Original comment', { exact: true }))
      .toBeVisible()
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    const draft = page.getByRole('textbox', { name: 'Reply', exact: true })
    await draft.fill('Posted across navigation')
    version = 'v2'
    await router.revalidate()
    await waitForBrowserLayout()
    await expect.element(draft).toHaveValue('Posted across navigation')
    expect(WaitingSocket.instances).toHaveLength(1)
    await page.getByRole('button', { name: 'Show 3 earlier replies' }).click()
    await expect
      .element(page.getByText('Reply 1', { exact: true }))
      .toBeVisible()
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect
      .element(page.getByRole('button', { name: 'Sending…', exact: true }))
      .toBeVisible()
    expect(trace.filter((entry) => entry.startsWith('POST'))).toHaveLength(1)
    await router.navigate('/a/b?comment=b-only')
    await expect
      .element(page.getByText('B original', { exact: true }))
      .toBeVisible()
    expect(document.body.textContent).not.toContain('Posted across navigation')
    await router.navigate('/a/a?comment=thread')
    await expect
      .element(page.getByText('Original comment', { exact: true }))
      .toBeVisible()
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    const newDraft = page.getByRole('textbox', { name: 'Reply', exact: true })
    await newDraft.fill('Posted across navigation')
    expect(finishPost).toBeTypeOf('function')
    finishPost!(Response.json({ threadId: 'thread', threads: [posted] }))
    finishPost = undefined
    await expect
      .element(page.getByText('Posted across navigation', { exact: true }))
      .toBeVisible()
    await expect.element(newDraft).toHaveValue('Posted across navigation')
    await waitForRealTaskCondition(
      () =>
        events.some(
          (event) =>
            event.operation === 'summary' && event.state === 'completed',
        ),
      'settlement summary completed',
    )
    expect(trace).toEqual([
      'GET /api/shareables/a/versions',
      `GET /api/shareables/a/comments?thread_id=thread&before=${encodeURIComponent(before)}&limit=50`,
      'POST /api/shareables/a/comments',
      'GET /api/shareables/b/versions',
      'GET /api/shareables/a/versions',
      'GET /api/shareables/a/comments',
    ])
    expect(WaitingSocket.instances).toHaveLength(3)
    expect(
      WaitingSocket.instances
        .slice(0, 2)
        .every((socket) => socket.readyState === 3),
    ).toBe(true)
    expect(
      events
        .filter((event) => event.state === 'started')
        .map(({ operation }) => ({ operation })),
    ).toEqual([
      { operation: 'socket' },
      { operation: 'page' },
      { operation: 'reply' },
      { operation: 'socket' },
      { operation: 'socket' },
      { operation: 'summary' },
    ])
    expect(
      events.find(
        (event) => event.operation === 'reply' && event.state === 'completed',
      ),
    ).toMatchObject({ result: 'success' })
    expect(
      events.find(
        (event) => event.operation === 'summary' && event.state === 'completed',
      ),
    ).toMatchObject({ result: 'http-error', status: 503 })
  } finally {
    // Drain the held POST even when an assertion fails; no unresolved Runtime job
    // may enter the next independent run.
    finishPost?.(Response.json({}, { status: 503 }))
    root.unmount()
    router.dispose()
    await waitForRealTaskCondition(
      () => !hasPendingCommentMutation('a'),
      'held panel post drained',
    )
    host.remove()
    log.mockRestore()
    vi.unstubAllGlobals()
  }
})

test('SSR/hydration and aborted navigation preserve the committed Session', async () => {
  let current: ReturnType<typeof useViewerComments> | undefined
  function View({
    artifact = 'ssr-artifact',
    suspend,
  }: {
    artifact?: string
    suspend?: Promise<never>
  }) {
    const comments = useViewerComments({
      artifactId: artifact,
      framePresent: false,
      currentUserId: 'reviewer',
      currentVersionId: null,
      initialThreads: [base],
      targetCommentId: null,
      liveEnabled: true,
    })
    if (suspend) throw suspend
    current = comments
    return <output>{comments.state.artifactId}</output>
  }
  const view = (artifact = 'ssr-artifact', suspend?: Promise<never>) => (
    <StrictMode>
      <Suspense fallback={<span>Suspended</span>}>
        <View artifact={artifact} suspend={suspend} />
      </Suspense>
    </StrictMode>
  )
  const host = document.createElement('div')
  const errors: unknown[] = []
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  WaitingSocket.instances = []
  vi.stubGlobal('WebSocket', WaitingSocket)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let root: Root | undefined
  try {
    host.innerHTML = renderToString(view())
    expect(host.textContent).toBe('ssr-artifact')
    expect(fetch).not.toHaveBeenCalled()
    expect(WaitingSocket.instances).toHaveLength(0)
    document.body.appendChild(host)
    await act(async () => {
      root = hydrateRoot(host, view(), {
        onRecoverableError: (error) => errors.push(error),
      })
    })
    const owner = current!.pageSession
    const initialSockets = WaitingSocket.instances.length
    expect(
      WaitingSocket.instances.filter((socket) => socket.readyState !== 3),
    ).toHaveLength(1)
    expect(host.textContent).toBe('ssr-artifact')
    await act(async () => root!.render(view('ssr-artifact')))
    expect(current!.pageSession).toBe(owner)
    await act(async () => {
      startTransition(() =>
        root!.render(view('aborted-artifact', new Promise<never>(() => {}))),
      )
    })
    // This navigation never commits a fallback/hide cycle. The original UI
    // stays revealed, so no replacement subscription or socket may attach.
    expect(host.textContent).toBe('ssr-artifact')
    await act(async () => root!.render(view('ssr-artifact')))
    expect(current!.pageSession).toBe(owner)
    expect(WaitingSocket.instances).toHaveLength(initialSockets)
    expect(
      WaitingSocket.instances.some((socket) =>
        socket.url.includes('aborted-artifact'),
      ),
    ).toBe(false)
    await act(async () => root!.render(view('next-artifact')))
    expect(current!.pageSession).not.toBe(owner)
    expect(
      WaitingSocket.instances.filter((socket) => socket.readyState !== 3),
    ).toHaveLength(1)
    expect(WaitingSocket.instances.at(-1)!.url).toContain('/next-artifact/live')
    expect(errors).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await act(async () => root?.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
