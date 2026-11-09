import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
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
