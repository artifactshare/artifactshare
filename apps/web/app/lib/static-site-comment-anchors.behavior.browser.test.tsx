import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { commands } from 'vitest/browser'
import type { CommentThreadView } from '~/lib/comments'
import {
  VIOLATION_REPORTER_SCRIPT_BODY,
  type AnchorResolutionMessage,
} from '~/lib/csp-reporter'
import { SandboxFrame } from '~/routes/a.$id/+components/sandbox-frame'
import type { PendingTextAnchor } from '~/routes/a.$id/+components/viewer-comment-types'

// The real reporter runs in synthetic static-site pages served from a
// separate origin; the real frame controller scopes comments to locations.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))

type Result = AnchorResolutionMessage['results'][number]
// Anchors settle after the frame's scripts and the reporter run, which is
// slower on CI's Linux engines than vi.waitFor's 1 s default.
function waitFor<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { timeout: 8000, interval: 50, ...options })
}

const originalUrl = window.location.href
let root: Root | undefined
let host: HTMLElement
let origin = ''
let selections: PendingTextAnchor[] = []
let locations: Array<string | null> = []
let verdicts: Result[] = []
let verdictLog: Result[][] = []
let reloads = 0
let writes: Array<{ targetPath: string; results: Result[] }> = []
let renewals: Array<{ release: () => void; response: Response }> = []
let clears = 0
let current: ComponentProps<typeof SandboxFrame>

beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname)
  selections = []
  locations = []
  verdicts = []
  verdictLog = []
  writes = []
  renewals = []
  clears = 0
  // Position writes are recorded; the server's location checks are unit
  // tested. Frame renewals are held until the test releases them; the
  // sandbox liveness probe is refused so recovery can be driven.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/sandbox-token')) {
        const response = Response.json({
          sandboxUrl: `${origin}/index.html?__as_token=renewal-${renewals.length}`,
          renderType: 'static_site',
        })
        let release!: () => void
        const released = new Promise<void>((done) => (release = done))
        renewals.push({ release, response })
        await released
        return response
      }
      if (url.startsWith(origin)) return new Response('', { status: 403 })
      if (typeof init?.body === 'string') writes.push(JSON.parse(init.body))
      return Response.json({ ok: true })
    }),
  )
  host = document.createElement('div')
  host.style.cssText = 'width:800px;height:600px'
  document.body.appendChild(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', originalUrl)
})

function page(body: string, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></head><body><main data-comment-content>${body}</main><script>${script}</script></body></html>`
}

async function render(patch: Partial<ComponentProps<typeof SandboxFrame>>) {
  current = { ...current, ...patch }
  await act(async () => {
    root ??= createRoot(host)
    root.render(<SandboxFrame key={current.url} {...current} />)
  })
}

// A reload is a fresh frame controller for the same saved threads.
async function open(
  path: string,
  threads: CommentThreadView[],
  site: { bundlePaths: string[]; fallbackToIndex: boolean },
  initial: Partial<ComponentProps<typeof SandboxFrame>> = {},
) {
  const [pathname, hash] = path.split('#')
  current = {
    renderType: 'static_site',
    canViewEnvironmentDiagnostics: false,
    shareableId: 'abc123def4',
    versionId: 'v1',
    url: `${origin}${pathname}?reload=${++reloads}${hash === undefined ? '' : '#' + hash}`,
    name: 'Static site',
    mermaidEnabled: false,
    textAnchorsEnabled: true,
    linkNavigationMode: 'site',
    bundlePaths: site.bundlePaths,
    fallbackToIndex: site.fallbackToIndex,
    commentThreads: threads,
    targetThreadId: null,
    highlightThreadId: null,
    followsAppTheme: false,
    onTextSelection: (selection) => selections.push(selection),
    onTextSelectionClear: () => clears++,
    onThreadSelect: () => {},
    onOutsidePointerDown: () => {},
    onAnchorResolutions: (results) => {
      verdicts = results
      verdictLog.push(results)
    },
    onCommentLocationChange: (location) => locations.push(location),
    sandboxPermissions:
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads',
    ...initial,
  }
  verdicts = []
  // The entry page's hash routes sync to the outer URL; a reload starts
  // from the requested location only.
  window.history.replaceState(null, '', window.location.pathname)
  await render({})
}

async function at(location: string) {
  await waitFor(
    () => {
      expect(locations.at(-1)).toBe(location)
      expect(
        host
          .querySelector('[data-sandbox-state]')
          ?.getAttribute('data-sandbox-state'),
      ).toBe('ready')
    },
    { timeout: 8000 },
  )
  // The selection command addresses the artifact frame by this id.
  host.querySelector('iframe')!.id = 'anchor-reporter'
}

function frame<T>(evaluate: string) {
  return commands.staticSiteFrame({ evaluate }) as Promise<T>
}
const painted = () =>
  frame<string[]>(
    '[...CSS.highlights.values()].flatMap((h) => [...h]).map((r) => r.toString().trim()).filter(Boolean)',
  )

async function select(selector: string, quote: string) {
  // The route's element can render after the location is reported.
  const text = await waitFor(async () => {
    const value = await frame<string | null>(
      `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`,
    )
    expect(value).toContain(quote)
    return value!
  })
  const start = text.indexOf(quote)
  const count = selections.length
  await commands.selectAnchorText(
    selector,
    start,
    selector,
    start + quote.length,
  )
  // Drags report intermediate selections; wait for the completed one.
  await waitFor(() => {
    expect(selections.length).toBeGreaterThan(count)
    expect(selections.at(-1)!.quotedText).toBe(quote)
  })
  return selections.at(-1)!
}

// The thread a server would return for a posted selection.
function posted(id: string, anchor: PendingTextAnchor): CommentThreadView {
  return thread(id, anchor.targetPath!, {
    quotedText: anchor.quotedText,
    prefixText: anchor.prefixText,
    suffixText: anchor.suffixText,
    selectorFormat: anchor.selectorFormat,
    textHash: anchor.textHash,
    ambiguousAtCreation: anchor.ambiguousAtCreation,
    textStart: anchor.textStart,
    textEnd: anchor.textEnd,
    cssPath: anchor.cssPath,
  })
}
function thread(
  id: string,
  targetPath: string,
  subject: Partial<Extract<CommentThreadView['subject'], { kind: 'text' }>>,
): CommentThreadView {
  return {
    id,
    status: 'open',
    createdAt: '2026-11-09T00:00:00Z',
    updatedAt: '2026-11-09T00:00:00Z',
    resolvedAt: null,
    canResolve: false,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [],
    subject: {
      kind: 'text',
      state: 'orphaned',
      positionState: 'unchecked',
      quotedText: '',
      prefixText: '',
      suffixText: '',
      versionId: 'v1',
      selectorFormat: 'quote-v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
      ...subject,
      targetPath,
    },
  }
}
const wholeArtifact: CommentThreadView = {
  ...thread('whole', '/index.html', {}),
  subject: { kind: 'artifact' },
}
const verdict = (id: string) =>
  verdicts.find((result) => result.threadId === id)?.state

const multiPage = {
  bundlePaths: ['/index.html', '/page.html', '/third.html'],
  fallbackToIndex: false,
}
const shared = '<p id="shared">Shared sentence on every page.</p>'
const multiPageFiles = () => ({
  '/index.html': page(
    `${shared}<p id="home">Home page paragraph.</p><a id="go" href="/page.html">Page</a>`,
  ),
  '/page.html': page(
    `<a id="home-link" href="/index.html">Home</a><div id="slot"></div>${shared}<p id="second">Second page paragraph.</p><div style="height:3000px"></div><div id="late"></div>`,
  ),
  '/third.html': page('<p id="third">Third page paragraph.</p>'),
})
const pageThreads = () => [
  thread('home', '/index.html', { quotedText: 'Home page paragraph.' }),
  thread('second', '/page.html', { quotedText: 'Second page paragraph.' }),
  thread('third', '/third.html', { quotedText: 'Third page paragraph.' }),
]
const choose = (threadId: string, targetRequest: number) =>
  render({
    targetThreadId: threadId,
    highlightThreadId: threadId,
    targetRequest,
  })

test('a deep-linked conversation opens its file; choosing it again after leaving returns there', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  await open('/index.html', pageThreads(), multiPage, {
    targetThreadId: 'second',
    highlightThreadId: 'second',
  })
  await at('/page.html')
  await waitFor(() => expect(verdict('second')).toBe('attached'))
  await commands.staticSiteFrame({ click: '#home-link' })
  await at('/index.html')
  // Leaving does not pull the reader back while the conversation stays chosen.
  await waitFor(() => expect(verdict('home')).toBe('attached'))
  expect(await frame<string>('location.pathname')).toBe('/index.html')
  await choose('second', 1)
  await at('/page.html')
  await waitFor(() => expect(verdict('second')).toBe('attached'))
})

// The response has been read once fetchJsonWithViewerTimeout consumed it.
async function deliver(index: number) {
  renewals[index].release()
  await waitFor(() => expect(renewals[index].response.bodyUsed).toBe(true))
  await act(async () => {})
}

test('held frame renewals navigate only for the latest conversation choice', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  await open('/index.html', pageThreads(), multiPage)
  await at('/index.html')
  // Let the handshake settle: a late repeated ready answer supersedes any
  // navigation pending at that moment.
  await waitFor(() => expect(verdict('home')).toBe('attached'))
  // Ten minutes later every jump renews frame authorization first.
  const now = Date.now.bind(Date)
  let offset = 10 * 60 * 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
  await choose('second', 1)
  await choose('third', 2)
  await waitFor(() => expect(renewals).toHaveLength(2))
  await deliver(0)
  await deliver(1)
  await at('/third.html')
  await waitFor(() => expect(verdict('third')).toBe('attached'))
  expect(await frame<string>('location.pathname')).toBe('/third.html')
  // A later choice on the displayed page supersedes a held jump as well.
  offset += 10 * 60 * 1000
  await choose('second', 3)
  await waitFor(() => expect(renewals).toHaveLength(3))
  await choose('third', 4)
  await deliver(2)
  expect(await frame<string>('location.pathname')).toBe('/third.html')
  expect(
    host
      .querySelector('[data-sandbox-state]')
      ?.getAttribute('data-sandbox-state'),
  ).toBe('ready')
  expect(verdict('third')).toBe('attached')
})

test('choosing a highlight on the displayed page cancels a held jump', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  const chosen: string[] = []
  await open('/index.html', pageThreads(), multiPage, {
    onThreadSelect: (threadId) => chosen.push(threadId),
  })
  await at('/index.html')
  await waitFor(() => expect(verdict('home')).toBe('attached'))
  const now = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 10 * 60 * 1000)
  await choose('second', 1)
  await waitFor(() => expect(renewals).toHaveLength(1))
  await commands.staticSiteFrame({
    click: '.ash-comment-highlight-badge[data-thread-id="home"]',
  })
  await waitFor(() => expect(chosen).toEqual(['home']))
  await deliver(0)
  expect(await frame<string>('location.pathname')).toBe('/index.html')
  expect(host.querySelector('iframe')!.src).not.toContain('renewal-0')
  expect(verdict('home')).toBe('attached')
})

test('history navigation during a held jump keeps the reader on the new route', async () => {
  origin = await commands.staticSiteCommentSite(historySpa, true)
  const threads = [
    thread('billing', '/billing', { quotedText: 'Billing route text.' }),
    thread('settings', '/settings', { quotedText: 'Settings route text.' }),
  ]
  await open('/billing', threads, spaSite)
  await at('/billing')
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
  await frame(`history.pushState(null, '', '/other')`)
  await at('/other')
  const now = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 10 * 60 * 1000)
  await choose('settings', 1)
  await waitFor(() => expect(renewals).toHaveLength(1))
  await frame('history.back()')
  await at('/billing')
  await deliver(0)
  expect(await frame<string>('location.pathname')).toBe('/billing')
  expect(host.querySelector('iframe')!.src).not.toContain('renewal-0')
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
})

test('multi-page threads keep their file, reload to it and ignore the same text elsewhere', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  await open('/', [], multiPage)
  await at('/index.html')
  const home = posted('home', await select('#shared', 'Shared sentence'))
  expect(home.subject).toMatchObject({ targetPath: '/index.html' })
  await commands.staticSiteFrame({ click: '#go' })
  await at('/page.html')
  const second = posted('second', await select('#shared', 'Shared sentence'))
  expect(second.subject).toMatchObject({ targetPath: '/page.html' })

  await open('/index.html', [home, second, wholeArtifact], multiPage)
  await at('/index.html')
  await waitFor(() => expect(verdict('home')).toBe('attached'))
  expect(await painted()).toEqual(['Shared sentence'])
  expect(verdict('second')).toBeUndefined()
  // Choosing the other file's conversation opens that file first.
  await render({ targetThreadId: 'second', highlightThreadId: 'second' })
  await at('/page.html')
  await waitFor(() => expect(verdict('second')).toBe('attached'))
  expect(verdict('home')).toBeUndefined()
  expect(await painted()).toEqual(['Shared sentence'])
  expect(await frame<string>('location.pathname')).toBe('/page.html')
  expect(
    writes.every((write) =>
      write.results.every(
        (result) =>
          (result.threadId === 'home') === (write.targetPath === '/index.html'),
      ),
    ),
  ).toBe(true)
})

test('in-page fragments and their targets never change a file comment location', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  await open('/page.html#intro', [], multiPage)
  await at('/page.html')
  // Posted before any #intro target exists.
  const selection = await select('#second', 'Second page')
  expect(selection.targetPath).toBe('/page.html')
  const saved = posted('second', selection)
  await render({ commentThreads: [saved] })
  await waitFor(async () => expect(await painted()).toEqual(['Second page']))
  for (const target of ['<h2 id="intro">Intro</h2>', '<a name="intro"></a>']) {
    await frame(`document.querySelector('#slot').innerHTML = '${target}'`)
    await frame(`location.hash = '#intro'`)
    await frame(`document.querySelector('#slot').innerHTML = ''`)
    await frame(`history.replaceState(null, '', '/page.html')`)
  }
  await frame(`new Promise((done) => requestAnimationFrame(() => done(null)))`)
  expect(new Set(locations)).toEqual(new Set(['/page.html']))
  expect(await painted()).toEqual(['Second page'])
  for (const path of ['/page.html', '/page.html#intro']) {
    await open(path, [saved], multiPage)
    await at('/page.html')
    await waitFor(() => expect(verdict('second')).toBe('attached'))
    expect(await painted()).toEqual(['Second page'])
  }
})

const historySpa = {
  '/index.html': page(
    '<div id="view"></div><button id="to-settings">Settings</button>',
    `// A retired route redirects at once; /index.html is not an app route.
    if (location.pathname === '/old') history.replaceState(null, '', '/settings')
    function render() {
      setTimeout(() => {
        const name = location.pathname === '/settings' ? 'Settings' : location.pathname === '/index.html' ? 'Unknown' : 'Billing'
        document.getElementById('view').innerHTML =
          '<p id="route">' + name + ' route text. Shared route words.</p>'
      }, 40)
    }
    document.getElementById('to-settings').onclick = () => {
      history.pushState(null, '', '/settings')
      render()
    }
    addEventListener('popstate', render)
    render()`,
  ),
}
const spaSite = { bundlePaths: ['/index.html'], fallbackToIndex: true }

test('history routes keep distinct locations through push, back and reload', async () => {
  origin = await commands.staticSiteCommentSite(historySpa, true)
  await open('/billing', [], spaSite)
  await at('/billing')
  const billing = posted('billing', await select('#route', 'Shared route'))
  expect(billing.subject).toMatchObject({ targetPath: '/billing' })
  await commands.staticSiteFrame({ click: '#to-settings' })
  await at('/settings')
  await waitFor(async () =>
    expect(await frame<string>('document.body.textContent')).toContain(
      'Settings route',
    ),
  )
  const settings = posted('settings', await select('#route', 'Shared route'))
  expect(settings.subject).toMatchObject({ targetPath: '/settings' })

  await open('/settings', [billing, settings], spaSite)
  await at('/settings')
  await waitFor(() => expect(verdict('settings')).toBe('attached'))
  expect(verdict('billing')).toBeUndefined()
  expect(await painted()).toEqual(['Shared route'])

  await open('/billing', [billing, settings], spaSite)
  await at('/billing')
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
  expect(verdict('settings')).toBeUndefined()
  writes = []
  await commands.staticSiteFrame({ click: '#to-settings' })
  await at('/settings')
  await waitFor(() => expect(verdict('settings')).toBe('attached'))
  expect(verdict('billing')).toBeUndefined()
  await frame('history.back()')
  await at('/billing')
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
  await frame('history.forward()')
  await at('/settings')
  // Returning to a route checks and saves it again under the same token.
  await waitFor(() =>
    expect(
      writes.filter((write) => write.targetPath === '/settings'),
    ).toHaveLength(2),
  )
  expect(await painted()).toEqual(['Shared route'])
  expect(
    writes.every((write) =>
      write.results.every(
        (result) => result.threadId === write.targetPath.slice(1),
      ),
    ),
  ).toBe(true)
  // Choosing a conversation on another route restores that route first.
  await render({ targetThreadId: 'billing', highlightThreadId: 'billing' })
  await at('/billing')
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
  expect(await frame<string>('location.pathname')).toBe('/billing')
})

test('an SPA root route stays `/` and choosing it reopens `/`, not /index.html', async () => {
  origin = await commands.staticSiteCommentSite(historySpa, true)
  await open('/', [], spaSite)
  await at('/')
  await waitFor(async () =>
    expect(await frame<string>('document.body.textContent')).toContain(
      'Billing route',
    ),
  )
  const home = posted('home', await select('#route', 'Billing route'))
  expect(home.subject).toMatchObject({ targetPath: '/' })
  await open('/settings', [home], spaSite)
  await at('/settings')
  await choose('home', 1)
  await at('/')
  await waitFor(() => expect(verdict('home')).toBe('attached'))
  expect(await frame<string>('location.pathname')).toBe('/')
  expect(await painted()).toEqual(['Billing route'])
})

test('a jump whose route redirects elsewhere ends in cannot-find', async ({
  onTestFailed,
}) => {
  // Remove this targeted diagnostic after the intermittent failure is localized.
  let phase = 'serve synthetic site'
  onTestFailed(() => {
    console.error('[static-site redirect failure]', {
      phase,
      locations: locations.slice(-8),
      billingVerdict: verdict('billing'),
      oldVerdict: verdict('old'),
      verdictBatchCount: verdictLog.length,
    })
  })
  origin = await commands.staticSiteCommentSite(historySpa, true)
  const threads = [
    thread('old', '/old', { quotedText: 'Settings route text.' }),
    thread('billing', '/billing', { quotedText: 'Billing route text.' }),
  ]
  phase = 'open /billing (act render)'
  await open('/billing', threads, spaSite)
  phase = 'wait for /billing location and ready'
  await at('/billing')
  phase = 'wait for billing attached verdict'
  await waitFor(() => expect(verdict('billing')).toBe('attached'))
  phase = 'choose old thread (act render)'
  await choose('old', 1)
  phase = 'wait for /settings location and ready'
  await at('/settings')
  phase = 'wait for old needs-check verdict'
  await waitFor(() =>
    expect(
      verdictLog.some((results) =>
        results.some(
          (result) =>
            result.threadId === 'old' && result.state === 'needs-check',
        ),
      ),
    ).toBe(true),
  )
  phase = 'read final pathname (staticSiteFrame evaluate)'
  expect(await frame<string>('location.pathname')).toBe('/settings')
  // The same text on the route the app moved to is not this conversation.
  phase = 'read painted highlights (staticSiteFrame evaluate)'
  expect(await painted()).toEqual([])
  phase = 'test body complete'
})

test('a selection from the previous route never becomes a draft on the next', async () => {
  origin = await commands.staticSiteCommentSite(historySpa, true)
  await open('/billing', [], spaSite)
  await at('/billing')
  await select('#route', 'Shared route')
  const count = selections.length
  // The route changes while the previous route's DOM is still shown.
  await frame(`history.pushState(null, '', '/settings')`)
  await at('/settings')
  const cleared = clears
  await frame(`document.dispatchEvent(new KeyboardEvent('keyup'))`)
  await waitFor(() =>
    expect(clears + selections.length).toBeGreaterThan(cleared + count),
  )
  expect(selections).toHaveLength(count)
  expect(await frame<string>('getSelection().toString()')).toBe('')
  // A fresh selection on the new route is a draft there.
  const fresh = await select('#route', 'Shared route')
  expect(fresh.targetPath).toBe('/settings')
})

test('recovery reopens the route the app moved to, not the original source', async () => {
  origin = await commands.staticSiteCommentSite(historySpa, true)
  await open('/billing', [], spaSite)
  await at('/billing')
  await commands.staticSiteFrame({ click: '#to-settings' })
  await at('/settings')
  // Interrupt the document and let the liveness check fail into retry.
  await act(async () => {
    const frameElement = host.querySelector('iframe')!
    const loaded = new Promise<void>((done) =>
      frameElement.addEventListener('load', () => done(), { once: true }),
    )
    frameElement.srcdoc = '<!doctype html><title>Interrupted</title>'
    await loaded
  })
  await act(async () =>
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    ),
  )
  await waitFor(
    () =>
      expect(
        host
          .querySelector('[data-sandbox-state]')
          ?.getAttribute('data-sandbox-state'),
      ).toBe('blocked'),
    { timeout: 8000 },
  )
  await act(async () => host.querySelector('button')!.click())
  await waitFor(() => expect(renewals).toHaveLength(1))
  await deliver(0)
  await waitFor(() =>
    expect(
      new URL(host.querySelector('iframe')!.src).searchParams.get('as_next'),
    ).toBe('/settings'),
  )
  await at('/settings')
  await waitFor(async () =>
    expect(await frame<string>('location.pathname')).toBe('/settings'),
  )
}, 20000)

const hashSpa = {
  '/index.html': page(
    '<div id="view"></div><div id="targets"></div>',
    `const names = { '#/billing': 'Billing', '#/settings': 'Settings', '#!/billing': 'Bang billing', '#!/settings': 'Bang settings', '#/search?q=a': 'Search' }
    function render() {
      setTimeout(() => {
        document.getElementById('view').innerHTML =
          '<p id="route">' + (names[location.hash] || 'Home') + ' hash text. Common hash words.</p>'
      }, 40)
    }
    addEventListener('hashchange', render)
    render()`,
  ),
}

test('hash routes with #/ and #!/ prefixes are distinct locations', async () => {
  origin = await commands.staticSiteCommentSite(hashSpa, false)
  const site = { bundlePaths: ['/index.html'], fallbackToIndex: false }
  await open('/index.html#/billing', [], site)
  const saved: CommentThreadView[] = []
  for (const [hash, name] of [
    ['#/billing', 'Billing'],
    ['#/settings', 'Settings'],
    ['#!/billing', 'Bang billing'],
    ['#!/settings', 'Bang settings'],
  ]) {
    if (saved.length) await frame(`location.hash = '${hash}'`)
    await at('/index.html' + hash)
    // Wait for the route's own rendering before measuring offsets.
    await waitFor(async () =>
      expect(
        await frame<string>('document.querySelector("#route")?.textContent'),
      ).toBe(`${name} hash text. Common hash words.`),
    )
    const selection = await select('#route', 'Common hash')
    expect(selection.targetPath).toBe('/index.html' + hash)
    saved.push(posted(hash, selection))
  }
  await open('/index.html#/settings', saved, site)
  await at('/index.html#/settings')
  await waitFor(() => expect(verdict('#/settings')).toBe('attached'))
  expect(verdicts.map((result) => result.threadId)).toEqual(['#/settings'])
  // A DOM target named like another route cannot reclassify the location.
  await frame(
    `document.getElementById('targets').innerHTML = '<a id="/billing" name="/billing"></a><a id="!/billing" name="!/billing"></a>'`,
  )
  expect(await painted()).toEqual(['Common hash'])
  await render({
    targetThreadId: '#!/billing',
    highlightThreadId: '#!/billing',
  })
  await at('/index.html#!/billing')
  await waitFor(() => expect(verdict('#!/billing')).toBe('attached'))
  expect(await frame<string>('location.hash')).toBe('#!/billing')
  expect(verdicts.map((result) => result.threadId)).toEqual(['#!/billing'])
})

test('a hash route with a query reopens the same route and query', async () => {
  origin = await commands.staticSiteCommentSite(hashSpa, false)
  const site = { bundlePaths: ['/index.html'], fallbackToIndex: false }
  await open('/index.html#/search?q=a', [], site)
  await at('/index.html#/search?q=a')
  await waitFor(async () =>
    expect(
      await frame<string>('document.querySelector("#route")?.textContent'),
    ).toBe('Search hash text. Common hash words.'),
  )
  const selection = await select('#route', 'Common hash')
  expect(selection.targetPath).toBe('/index.html#/search?q=a')
  const saved = posted('search', selection)
  await open('/index.html#/billing', [saved], site)
  await at('/index.html#/billing')
  await render({ targetThreadId: 'search', highlightThreadId: 'search' })
  await at('/index.html#/search?q=a')
  await waitFor(() => expect(verdict('search')).toBe('attached'))
  expect(await frame<string>('location.hash')).toBe('#/search?q=a')
  expect(await painted()).toEqual(['Common hash'])
})

test('a missing quote reaches cannot-find, late text completes the latest jump', async () => {
  origin = await commands.staticSiteCommentSite(multiPageFiles(), false)
  const missing = thread('missing', '/page.html', { quotedText: 'Never shown' })
  const late = thread('late', '/page.html', { quotedText: 'Arrives later' })
  // The quote exists only on another file: it must not attach here.
  const elsewhere = thread('elsewhere', '/index.html', {
    quotedText: 'Second page paragraph.',
  })
  await open('/index.html', [missing, late, elsewhere], multiPage)
  await at('/index.html')
  await waitFor(() => expect(verdict('elsewhere')).toBe('checking'))
  // Only the latest choice navigates.
  await render({ targetThreadId: 'missing', highlightThreadId: 'missing' })
  await render({ targetThreadId: 'late', highlightThreadId: 'late' })
  await at('/page.html')
  await waitFor(() => expect(verdict('missing')).toBe('needs-check'), {
    timeout: 8000,
  })
  expect(verdict('elsewhere')).toBeUndefined()
  expect(await frame<number>('scrollY')).toBe(0)
  await frame(
    `document.getElementById('late').innerHTML = '<p>Arrives later than the rest.</p>'`,
  )
  await waitFor(() => expect(verdict('late')).toBe('attached'))
  await waitFor(async () =>
    expect(await frame<number>('scrollY')).toBeGreaterThan(1000),
  )
  expect(await painted()).toEqual(['Arrives later'])
  // A page this version does not serve cannot hold the text.
  const gone = thread('gone', '/removed.html', { quotedText: 'Gone' })
  await render({ commentThreads: [missing, late, gone] })
  await render({ targetThreadId: 'gone', highlightThreadId: 'gone' })
  await waitFor(() =>
    expect(
      verdictLog.some((results) =>
        results.some(
          (result) =>
            result.threadId === 'gone' && result.state === 'needs-check',
        ),
      ),
    ).toBe(true),
  )
  expect(await frame<string>('location.pathname')).toBe('/page.html')
})
