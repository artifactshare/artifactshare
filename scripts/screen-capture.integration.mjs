import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureScreenImages } from './screen-capture.mjs'
import { captureStep } from './task-walkthrough-capture.mjs'
import { taskWalkthroughs } from './task-walkthroughs.mjs'

test('full-page screenshot paints the bottom bar once, below all content', async (t) => {
  const { chromium } = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )('playwright')
  const browser = process.env.PLAYWRIGHT_WS
    ? await chromium.connect(process.env.PLAYWRIGHT_WS)
    : await chromium.launch()
  t.after(() => browser.close())
  const outDir = await mkdtemp(join(tmpdir(), 'full-page-capture-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const page = await browser.newPage({ viewport: { width: 320, height: 200 } })
  for (const mode of ['screen', 'walkthrough', 'recent-pending']) {
    for (const contentHeight of mode === 'recent-pending' ? [500] : [500, 80]) {
      const html = `
      <style>
        body { margin: 0 }
        main { height: ${contentHeight}px; background: blue }
        nav { position: fixed; inset: auto 0 0; height: 40px; background: red }
      </style>
      <main><a style="margin-left:20px" href="/recent?page=2">Next</a></main>
      <nav data-bottom-tab-bar></nav>
      <script>
        document.querySelector('a').onclick = event => {
          event.preventDefault()
          fetch(event.currentTarget.href)
        }
      </script>
    `
      if (mode === 'recent-pending') {
        await page.route('https://fixture.test/recent', (route) =>
          route.fulfill({ contentType: 'text/html', body: html }),
        )
        await page.goto('https://fixture.test/recent')
      } else await page.setContent(html)
      const file = 'mobile.png'
      const screenshot = { path: join(outDir, file), fullPage: true }
      if (mode === 'screen')
        await captureScreenImages({ page, outDir, entry: { file } })
      else if (mode === 'walkthrough')
        await captureStep({
          page,
          action: { kind: 'inspect', selector: 'main' },
          screenshot,
        })
      else {
        const { action } = taskWalkthroughs
          .find((task) => task.taskId === 'return-to-recent-file')
          .steps.find((step) => step.phase === 'pending')
        let held = false
        const pagination = new EventEmitter()
        const gate = Promise.withResolvers()
        await page.route('**/recent?page=2', async (route) => {
          held = true
          pagination.emit('intercepted')
          await gate.promise
          held = false
          await route.fulfill({ body: 'page two' })
        })
        const locate = page.locator.bind(page)
        const paginationLink = locate(action.selector)
        const click = paginationLink.click.bind(paginationLink)
        t.mock.method(paginationLink, 'click', async (...args) => {
          await Promise.all([
            once(pagination, 'intercepted', {
              signal: AbortSignal.timeout(5000),
            }),
            click(...args),
          ])
        })
        const locator = t.mock.method(page, 'locator', (selector, options) =>
          selector === action.selector
            ? paginationLink
            : locate(selector, options),
        )
        const save = page.screenshot.bind(page)
        const attempt = t.mock.method(page, 'screenshot', (options) => {
          assert.ok(held, 'pagination response held at PNG attempt')
          return save(options)
        })
        try {
          await captureStep({ page, action, screenshot })
          assert.equal(attempt.mock.callCount(), 1)
        } finally {
          gate.resolve()
          locator.mock.restore()
          attempt.mock.restore()
          await page.unrouteAll({ behavior: 'wait' })
        }
      }
      assert.equal(
        await page
          .locator('nav')
          .evaluate((nav) => getComputedStyle(nav).position),
        'fixed',
      )
      const png = await readFile(join(outDir, file), 'base64')
      // Read one column of the saved PNG. The solid bands span the entire width.
      const rows = await page.evaluate(async (base64) => {
        const image = new Image()
        image.src = 'data:image/png;base64,' + base64
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = image.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        return Array.from(ctx.getImageData(0, 0, 1, image.height).data)
      }, png)
      for (let y = 0; y < contentHeight; y++)
        assert.deepEqual(
          rows.slice(y * 4, y * 4 + 4),
          [0, 0, 255, 255],
          `content at row ${y}`,
        )
      const imageHeight = Math.max(200, contentHeight + 40)
      assert.equal(rows.length / 4, imageHeight, 'full-page image height')
      for (let y = imageHeight - 40; y < imageHeight; y++)
        assert.deepEqual(
          rows.slice(y * 4, y * 4 + 4),
          [255, 0, 0, 255],
          `bottom bar at row ${y}`,
        )
    }
  }
})
