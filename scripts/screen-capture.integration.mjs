import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureScreenImages } from './screen-capture.mjs'

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
  await page.setContent(`
    <style>
      body { margin: 0 }
      main { height: 500px; background: blue }
      nav { position: fixed; inset: auto 0 0; height: 40px; background: red }
    </style>
    <main></main><nav data-bottom-tab-bar></nav>
  `)
  const file = 'mobile.png'
  await captureScreenImages({ page, outDir, entry: { file } })
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
  for (let y = 0; y < 500; y++)
    assert.deepEqual(
      rows.slice(y * 4, y * 4 + 4),
      [0, 0, 255, 255],
      `content at row ${y}`,
    )
  assert.equal(rows.length / 4, 540, 'content plus one bottom bar')
  for (let y = 500; y < 540; y++)
    assert.deepEqual(
      rows.slice(y * 4, y * 4 + 4),
      [255, 0, 0, 255],
      `bottom bar at row ${y}`,
    )
})
