import assert from 'node:assert/strict'
import test from 'node:test'
import { openPopup, requiredWait } from '../apps/web/app/test/browser-waits.ts'

test('real browser readiness fault and popup cancellation release native listeners', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent('<button id="ready">Ready</button>')
    await requiredWait(
      'fixture ready',
      page.waitForFunction(() => !!document.querySelector('#ready')),
    )
    await assert.rejects(
      requiredWait(
        'wrong completion condition',
        page.waitForFunction(
          () => !!document.querySelector('#missing'),
          undefined,
          {
            timeout: 50,
          },
        ),
      ),
      /wrong completion condition/,
    )
    const listeners = context.listenerCount('page')
    const failureStarted = performance.now()
    await assert.rejects(
      openPopup(context, () =>
        Promise.reject(new Error('injected trigger failure')),
      ),
      /popup trigger/,
    )
    assert.ok(
      performance.now() - failureStarted < 15_000,
      'trigger failure must abort before the native 30-second deadline',
    )
    assert.equal(context.listenerCount('page'), listeners)
    const popup = await openPopup(context, () =>
      page.evaluate(() => {
        window.open('about:blank')
      }),
    )
    assert.notEqual(popup, page)
    assert.equal(context.listenerCount('page'), listeners)
    await context.close()
  } finally {
    await browser.close()
  }
})
