import { createHash } from 'node:crypto'
import { renderMarkdownDocument } from '../lib/markdown-render'
import { runInNewContext } from 'node:vm'
import type { Page } from 'playwright'
import { expect, test, vi } from 'vitest'
import {
  collectUsercontentReports,
  instrumentMarkdownFixture,
  navigateUsercontentViewer,
  usercontentFixtureScript,
  waitForUsercontentState,
} from './usercontent-frame-navigation'

const origin = 'https://l-abc123def4--v-7631.usercontent.example'

function collector() {
  let receive!: (event: unknown) => void
  const source = {}
  const window = {
    usercontentReports: [] as unknown[],
    addEventListener: (_type: string, listener: typeof receive) => {
      receive = listener
    },
  }
  const frame = {
    dataset: { src: `${origin}/?t=secret` },
    contentWindow: source,
  }
  runInNewContext(`(${collectUsercontentReports.toString()})()`, {
    window,
    document: { querySelector: () => frame },
    URL,
    location: { href: 'https://abc123def4.link.example/' },
  })
  return { window, source, receive }
}

test('collects early reports without an automation frame tree and rejects wrong origins/windows', () => {
  const f = collector()
  const state = {
    nonce: 'first-load',
    heading: 'Local delivery',
    hash: '#section',
  }
  const data = { type: 'usercontent-fixture-state', state }
  for (const wrong of [
    'https://a-abc123def4--v-7631.usercontent.example',
    'https://abc123def4.sandbox.app.example',
    'null',
  ])
    f.receive({ origin: wrong, source: f.source, data })
  f.receive({ origin, source: {}, data })
  f.receive({ origin, source: f.source, data: { type: 'other', state } })
  expect(f.window.usercontentReports).toEqual([])
  f.receive({ origin, source: f.source, data })
  expect(f.window.usercontentReports).toEqual([{ origin, state }])
})

test('navigation waits for product ready without frame tracking or response gating', async () => {
  const order: string[] = []
  const page = {
    locator: (selector: string) => ({
      waitFor: async () => {
        order.push(selector)
      },
    }),
    frames: () => {
      throw new Error('Frame tracking must not be used')
    },
  } as unknown as Page
  await navigateUsercontentViewer(page, async () => {
    order.push('navigate')
  })
  expect(order).toEqual(['navigate', '[data-sandbox-state="ready"]'])
})

test('state waits require the expected origin, content and a fresh load nonce', async () => {
  const state = { nonce: 'fresh', heading: 'Next page', pathname: '/next.html' }
  const reports = [
    { origin: 'https://sibling.usercontent.example', state },
    { origin, state: { ...state, nonce: 'old' } },
    { origin, state: { ...state, heading: 'Wrong page' } },
  ]
  const page = {
    waitForFunction: async (fn: Function, args: unknown) => {
      const evaluate = () =>
        runInNewContext(`(${fn.toString()})(args)`, {
          window: { usercontentReports: reports },
          args,
        })
      expect(evaluate()).toBeUndefined()
      reports.push({ origin, state })
      return { jsonValue: async () => evaluate() }
    },
  } as unknown as Page
  expect(
    await waitForUsercontentState(
      page,
      origin,
      { heading: 'Next page', pathname: '/next.html' },
      'old',
    ),
  ).toEqual(state)
})

test('uploaded observer measures DOM and assets and accepts only bound parent commands', async () => {
  const listeners = new Map<string, Function>()
  const postMessage = vi.fn()
  const fetch = vi.fn(async () => ({ status: 401 }))
  const location = {
    hostname: new URL(origin).hostname,
    pathname: '/index.html',
    hash: '#section',
  }
  const parent = { postMessage }
  const context = {
    window: {
      addEventListener: (event: string, fn: Function) =>
        listeners.set(event, fn),
    },
    parent,
    location,
    crypto: { randomUUID: () => 'load-nonce' },
    fetch,
    document: {
      querySelector: () => ({ textContent: 'Local delivery' }),
      body: {
        textContent: 'Local delivery',
        getAttribute: (name: string) =>
          name === 'data-asset' ? 'loaded' : 'attempted',
      },
    },
    getComputedStyle: () => ({ getPropertyValue: () => ' loaded ' }),
  }
  const script = usercontentFixtureScript('link').replace(
    /^<script>|<\/script>$/g,
    '',
  )
  runInNewContext(script, context)
  listeners.get('load')!()
  expect(postMessage.mock.calls[0][0].state).toMatchObject({
    nonce: 'load-nonce',
    heading: 'Local delivery',
    asset: 'loaded',
    style: 'loaded',
    hash: '#section',
  })
  const command = {
    type: 'usercontent-fixture-command',
    nonce: 'load-nonce',
    command: 'asset-status',
    id: 'request-1',
  }
  const parentOrigin = 'https://abc123def4.link.example'
  for (const event of [
    { origin: 'https://other.link.example', source: parent, data: command },
    { origin: parentOrigin, source: {}, data: command },
    {
      origin: parentOrigin,
      source: parent,
      data: { ...command, nonce: 'stale' },
    },
    {
      origin: parentOrigin,
      source: parent,
      data: { ...command, command: 'arbitrary' },
    },
  ])
    await listeners.get('message')!(event)
  expect(fetch).not.toHaveBeenCalled()
  await listeners.get('message')!({
    origin: parentOrigin,
    source: parent,
    data: command,
  })
  expect(fetch).toHaveBeenCalledWith('/style.css')
  expect(postMessage.mock.lastCall).toEqual([
    expect.objectContaining({
      state: expect.objectContaining({ commandId: 'request-1', status: 401 }),
    }),
    parentOrigin,
  ])
})

test('rendered Markdown retains content and policy with only the exact observer hash added', () => {
  const body = renderMarkdownDocument('# Local delivery\n\n## Section')
  const script = usercontentFixtureScript('https://app.example')
  const policy =
    "default-src 'none'; script-src 'sha256-existing'; connect-src 'none'; frame-ancestors https://app.example"
  const result = instrumentMarkdownFixture(body, policy, script)
  expect(result.body.replace(script, '')).toBe(body)
  expect(result.body).toContain('<h1 id="local-delivery">Local delivery</h1>')
  const source = script.slice('<script>'.length, -'</script>'.length)
  const hash = createHash('sha256').update(source).digest('base64')
  expect(result.policy).toBe(
    policy.replace('script-src ', `script-src 'sha256-${hash}' `),
  )
  expect(result.policy).not.toContain('unsafe-inline')
})
