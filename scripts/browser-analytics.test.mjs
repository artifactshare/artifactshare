import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  analyticsHostPattern,
  newAppBrowserContext,
} from './lib/browser-analytics.mjs'

function fakeBrowser({ routeError } = {}) {
  const calls = { options: null, routes: [], closed: false }
  const context = {
    route: (pattern, handler) => {
      if (routeError) return Promise.reject(routeError)
      calls.routes.push({ pattern, handler })
      return Promise.resolve()
    },
    close: () => {
      calls.closed = true
      return Promise.resolve()
    },
  }
  return {
    calls,
    context,
    browser: {
      newContext: (options) => {
        calls.options = options
        return Promise.resolve(context)
      },
    },
  }
}

function answer(handler, url) {
  let fulfilled
  handler({
    request: () => ({ url: () => url }),
    fulfill: (response) => {
      fulfilled = response
    },
  })
  return fulfilled
}

test('app browser contexts answer analytics requests before any page opens', async () => {
  const { browser, calls, context } = fakeBrowser()
  const options = { viewport: { width: 390, height: 844 } }
  assert.equal(await newAppBrowserContext(browser, options), context)
  assert.equal(calls.options, options)
  assert.equal(calls.routes.length, 1)
  const [{ pattern, handler }] = calls.routes
  assert.equal(pattern, analyticsHostPattern)
  assert.deepEqual(
    answer(handler, 'https://www.googletagmanager.com/gtag/js?id=G-TEST'),
    { status: 200, contentType: 'text/javascript', body: '' },
  )
  assert.deepEqual(
    answer(handler, 'https://region1.google-analytics.com/g/collect?v=2'),
    { status: 204, body: '' },
  )
})

test('the analytics pattern leaves app and look-alike hosts to the network', () => {
  for (const url of [
    'https://www.googletagmanager.com/gtag/js',
    'https://www.google-analytics.com/g/collect',
  ])
    assert.match(url, analyticsHostPattern)
  for (const url of [
    'https://localhost:20000/settings/analytics',
    'https://googletagmanager.com.example/gtag/js',
    'https://example.com/?u=https://www.googletagmanager.com/',
  ])
    assert.doesNotMatch(url, analyticsHostPattern)
})

test('a context whose analytics route fails is closed and the failure kept', async () => {
  const routeError = new Error('route failed')
  const { browser, calls } = fakeBrowser({ routeError })
  await assert.rejects(newAppBrowserContext(browser, {}), routeError)
  assert.equal(calls.closed, true)
})

// Scripts that open a browser context without loading the app, with the reason.
const contextsWithoutApp = new Map([
  ['scripts/browser-waits.integration.mjs', 'renders fixed setContent markup'],
])

const scriptExtensions = /\.(?:mjs|cjs|js|mts|cts|ts)$/u

async function scriptFiles(root, dir) {
  const files = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules')
        files.push(...(await scriptFiles(root, path)))
    } else if (scriptExtensions.test(entry.name)) files.push(path)
  }
  return files
}

test('scripts open app browser contexts only through newAppBrowserContext', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dirs = ['scripts', 'apps/web/scripts']
  for (const entry of await readdir(join(root, 'packages'), {
    withFileTypes: true,
  }))
    if (entry.isDirectory())
      try {
        await readdir(join(root, 'packages', entry.name, 'scripts'))
        dirs.push(join('packages', entry.name, 'scripts'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
  const direct = []
  for (const dir of dirs)
    for (const file of (await scriptFiles(root, dir)).map((path) =>
      path.split(sep).join('/'),
    )) {
      // The helper itself, and this test, which names the call it searches for.
      if (
        file === 'scripts/lib/browser-analytics.mjs' ||
        file === 'scripts/browser-analytics.test.mjs'
      )
        continue
      if (contextsWithoutApp.has(file)) continue
      if ((await readFile(join(root, file), 'utf8')).includes('.newContext('))
        direct.push(file)
    }
  assert.deepEqual(direct, [])
})
