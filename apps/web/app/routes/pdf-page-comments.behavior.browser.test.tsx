import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { hasPendingCommentMutation } from './a.$id/+components/use-comment-mutations'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentThreadView } from '~/lib/comments'
import { SANDBOX_READY_CHECK_MESSAGE } from '~/lib/csp-reporter'
import {
  ViewerShell,
  type ViewerShellArtifact,
} from './a.$id/+components/viewer-shell'

// The real viewer shell, comment panel and frame controller. The frame holds a
// stand-in for the PDF viewer that speaks its page protocol (the viewer's own
// side is covered by pdf-viewer.behavior.browser.test.tsx); the comments API
// keeps what is posted, so a remount reads it back like a reload.
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

const at = '2026-05-01T00:00:00.000Z'
const reviewer = {
  id: 'reviewer',
  name: 'Reviewer',
  email: 'reviewer@example.com',
  image: null,
}

// Opens at page 1 of 14, answers the ready check, reports its page under the
// token it is given and opens pages its parent asks for. The test moves it
// the way a reader would with a 'reader-go' message.
const standInViewer = `<!doctype html><title>Stand-in PDF</title>
<output id="page">1</output>
<script>
const readyCheck = ${JSON.stringify(SANDBOX_READY_CHECK_MESSAGE)}
const pageCount = 14
let page = 1
let token = null
function show() {
  document.getElementById('page').textContent = String(page)
  if (token)
    parent.postMessage({ source: 'artifactshare', kind: 'pdf-page-changed', token, state: 'ready', pageNumber: page, pageCount }, '*')
}
addEventListener('message', (event) => {
  if (event.source !== parent) return
  const message = event.data || {}
  if (message.source === readyCheck.source && message.kind === readyCheck.kind)
    parent.postMessage({ source: 'artifactshare', kind: 'ready' }, '*')
  else if (message.kind === 'pdf-page-sync') { token = message.token; show() }
  else if (message.kind === 'pdf-open-page' || message.kind === 'reader-go') {
    if (message.pageNumber >= 1 && message.pageNumber <= pageCount) page = message.pageNumber
    show()
  }
})
</script>`

class UnavailableSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  send() {}
  close() {
    this.readyState = 3
  }
}

let stored: CommentThreadView[] = []
const posted: unknown[] = []
let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
let frameUrl: string | undefined

function storedThread(anchor: {
  pageNumber: number
  versionId: string
}): CommentThreadView {
  return {
    id: 'page-thread',
    status: 'open',
    subject: {
      kind: 'pdf-page',
      pageNumber: anchor.pageNumber,
      versionId: anchor.versionId,
      versionNumber: 1,
      canNavigate: true,
      navigableVersionId: anchor.versionId,
    },
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    canResolve: true,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [
      {
        id: 'page-message',
        body: 'The legend is reversed',
        createdAt: at,
        updatedAt: at,
        agent: null,
        canEdit: true,
        canDelete: true,
        author: reviewer,
      },
    ],
  }
}

function stubApi() {
  vi.stubGlobal('WebSocket', UnavailableSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/comments')) return Response.json({})
      if (init?.method !== 'POST') return Response.json({ threads: stored })
      const body = JSON.parse(String(init.body)) as {
        anchor: { pageNumber: number; versionId: string }
      }
      posted.push(body)
      stored = [storedThread(body.anchor)]
      return Response.json({ threadId: 'page-thread', threads: stored })
    }),
  )
}

async function mount() {
  frameUrl = URL.createObjectURL(
    new Blob([standInViewer], { type: 'text/html' }),
  )
  const artifact: ViewerShellArtifact = {
    id: 'abc123def4',
    storageKey: 'abc123def4/Deck.pdf',
    name: 'Deck',
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
    currentVersionId: 'v1',
    comments: stored,
  }
  router = createMemoryRouter(
    [
      {
        path: '/a/:id',
        element: (
          <TooltipProvider>
            <ViewerShell
              artifact={artifact}
              user={{ ...reviewer, initial: 'R' }}
              renderType="pdf"
              sandboxUrl={frameUrl}
              bundlePaths={[]}
            />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: ['/a/abc123def4'] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: 'Comments', exact: true }).click()
}

function unmount() {
  root?.unmount()
  router?.dispose()
  if (frameUrl) URL.revokeObjectURL(frameUrl)
  root = undefined
  router = undefined
  frameUrl = undefined
  document.body.replaceChildren()
}

function frameWindow() {
  return document.querySelector('iframe')!.contentWindow!
}

function framePage() {
  return frameWindow().document.getElementById('page')?.textContent
}

afterEach(() => {
  unmount()
  stored = []
  posted.length = 0
  vi.unstubAllGlobals()
})

test('posts a comment on the page shown, and after a reload opens that page from its card', async () => {
  stubApi()
  await mount()
  const label = (pageNumber: number) =>
    page.getByText(`Page ${pageNumber}`, { exact: true })
  await expect.element(label(1)).toBeVisible()

  // The reader moves to page 12; the new comment follows.
  frameWindow().postMessage({ kind: 'reader-go', pageNumber: 12 }, '*')
  await expect.element(label(12)).toBeVisible()
  await page
    .getByRole('textbox', { name: 'New comment' })
    .fill('The legend is reversed')
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted[0]).toMatchObject({
    intent: 'create-thread',
    body: 'The legend is reversed',
    anchor: { kind: 'pdf-page', pageNumber: 12, versionId: 'v1' },
  })
  await expect
    .element(page.getByRole('button', { name: 'Open page 12' }))
    .toBeVisible()

  // After a reload the viewer opens at page 1; the card opens page 12.
  unmount()
  await mount()
  await expect.element(label(1)).toBeVisible()
  await page.getByRole('button', { name: 'Open page 12' }).click()
  await vi.waitFor(() => expect(framePage()).toBe('12'))
  await expect.element(label(12)).toBeVisible()
})

function holdPdfPosts() {
  stubApi()
  const fetch = globalThis.fetch
  const finishes: Array<(response: Response) => void> = []
  const requests: Array<{ body: string; intent: string; anchor?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return fetch(input, init)
      requests.push(JSON.parse(String(init.body)))
      return new Promise<Response>((resolve) => finishes.push(resolve))
    }),
  )
  const settle = async () => {
    for (const finish of finishes) finish(Response.json({ threads: [] }))
    await vi.waitFor(() =>
      expect(hasPendingCommentMutation('abc123def4')).toBe(false),
    )
  }
  return { requests, settle }
}

test.each(['body', 'attachment intent'] as const)(
  'critical draft: PDF preserves changed %s and resets only after unchanged success',
  async (change) => {
    const held = holdPdfPosts()
    try {
      await mount()
      const remove = page.getByRole('button', {
        name: 'Remove page 1 and comment on the whole file',
        exact: true,
      })
      await expect.element(remove).toBeVisible()
      const draft = page.getByRole('textbox', { name: 'New comment' })
      const post = page.getByRole('button', { name: 'Post', exact: true })
      const a = '  PDF draft A  '
      const b = change === 'body' ? a + '[UNSENT ADDITION]' : a
      if (change === 'body') await remove.click()
      await draft.fill(a)
      await post.click()
      await vi.waitFor(() => expect(held.requests).toHaveLength(1))
      expect(held.requests[0]).toMatchObject({
        intent: 'create-thread',
        body: a,
      })
      expect(held.requests[0].anchor).toEqual(
        change === 'body'
          ? undefined
          : { kind: 'pdf-page', pageNumber: 1, versionId: 'v1' },
      )
      if (change === 'body') await draft.fill(b)
      else await remove.click()
      await held.settle()
      await expect.element(draft).toHaveValue(b)
      await expect.element(remove).not.toBeInTheDocument()
      await expect.element(post).not.toHaveAttribute('aria-busy')
      await post.click()
      await vi.waitFor(() => expect(held.requests).toHaveLength(2))
      expect(held.requests[1]).toMatchObject({
        intent: 'create-thread',
        body: b,
      })
      expect(held.requests[1].anchor).toBeUndefined()
      await held.settle()
      await expect.element(draft).toHaveValue('')
      await expect.element(remove).toBeVisible()
    } finally {
      await held.settle()
    }
  },
)

test.each([false, true])(
  'critical draft: panel keyboard success respects moved focus (%s)',
  async (moveFocus) => {
    const held = holdPdfPosts()
    try {
      await mount()
      const draft = page.getByRole('textbox', { name: 'New comment' })
      await draft.fill('  Keyboard post  ')
      const post = page.getByRole('button', { name: 'Post', exact: true })
      // Focus the submission target explicitly: macOS WebKit skips buttons
      // with ordinary Tab. Activation and post-success navigation use keys.
      const postButton = post.element() as HTMLButtonElement
      postButton.focus()
      await expect.element(post).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => expect(held.requests).toHaveLength(1))
      const other = page.getByRole('tab', { name: 'All', exact: true })
      if (moveFocus) (other.element() as HTMLElement).focus()
      await held.settle()
      await expect.element(draft).toHaveValue('')
      if (moveFocus) await expect.element(other).toHaveFocus()
      else {
        await expect.element(draft).toHaveFocus()
        await userEvent.keyboard('{Tab}')
        await expect
          .element(
            page.getByRole('link', {
              name: 'Artifact Share home',
              exact: true,
            }),
          )
          .toHaveFocus()
      }
    } finally {
      await held.settle()
    }
  },
)
