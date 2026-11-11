import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openPopup,
  requiredWait,
  waitForMenuClose,
} from '../apps/web/app/test/browser-waits.ts'

test('real browser waits enforce menu cleanup and release cancelled popup listeners', async () => {
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
    await popup.close()
    await page.setContent(
      '<button id="menu-trigger">More</button>' +
        '<div role="menu" data-state="closed" tabindex="-1">Closing</div>',
    )
    await page.getByRole('menu').focus()
    page.setDefaultTimeout(100)
    // A closed attribute is not unmount: the exit animation can still own focus.
    await assert.rejects(
      waitForMenuClose(page, '#menu-trigger'),
      /menu unmount/,
    )
    page.setDefaultTimeout(30000)
    await page.getByRole('menu').evaluate((menu) => menu.remove())
    // Unmount alone is not enough: FocusScope restores focus in a later task.
    page.setDefaultTimeout(100)
    await assert.rejects(
      waitForMenuClose(page, '#menu-trigger'),
      /menu trigger focus restoration/,
    )
    page.setDefaultTimeout(30000)
    await page.locator('#menu-trigger').focus()
    await waitForMenuClose(page, '#menu-trigger')
    await context.close()
  } finally {
    await browser.close()
  }
})
