import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  pickBundle,
  renderPdfViewer,
  writePdfViewer,
} from './build-pdf-viewer.mjs'

const rendered = renderPdfViewer()

test('rebuilds the committed viewer script and stylesheet byte for byte', async () => {
  const first = await rendered
  const second = await renderPdfViewer()

  assert.equal(second.sources.script, first.sources.script)
  assert.equal(second.sources.style, first.sources.style)
  // pdf.js loads at run time from the sandbox origin, not from the bundle.
  assert.match(first.script, /\/__as_pdf\/pdfjs\//)
  await writePdfViewer(first, { check: true })
})

test('check mode rejects a missing or stale script or stylesheet without writing', async () => {
  const bundle = await rendered
  const directory = await mkdtemp(join(tmpdir(), 'pdf-viewer-'))
  try {
    const outputs = {
      script: join(directory, 'script.generated.ts'),
      style: join(directory, 'style.generated.ts'),
    }
    await assert.rejects(
      writePdfViewer(bundle, { outputs, check: true }),
      /script\.generated\.ts is missing or stale/,
    )
    await assert.rejects(stat(outputs.script), { code: 'ENOENT' })
    await writePdfViewer(bundle, { outputs })
    await writePdfViewer(bundle, { outputs, check: true })
    for (const kind of ['script', 'style']) {
      const current = await readFile(outputs[kind], 'utf8')
      const stale = current.replace('export const', 'export  const')
      await writeFile(outputs[kind], stale)
      await assert.rejects(
        writePdfViewer(bundle, { outputs, check: true }),
        new RegExp(`${kind}\\.generated\\.ts is missing or stale`),
      )
      assert.equal(await readFile(outputs[kind], 'utf8'), stale)
      await writeFile(outputs[kind], current)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('accepts only one self-contained script and one stylesheet', () => {
  const chunk = {
    type: 'chunk',
    fileName: 'viewer.js',
    code: 'void 0',
    imports: [],
    dynamicImports: [],
  }
  const style = { type: 'asset', fileName: 'viewer.css', source: 'a{}' }

  assert.deepEqual(pickBundle([chunk, style]), {
    script: 'void 0',
    style: 'a{}',
  })
  assert.throws(
    () => pickBundle([chunk, style, { ...chunk, fileName: 'extra.js' }]),
    /viewer\.js and viewer\.css only/,
  )
  assert.throws(
    () => pickBundle([{ ...chunk, dynamicImports: ['extra.js'] }, style]),
    /must not import other chunks/,
  )
  assert.throws(
    () =>
      pickBundle([
        chunk,
        { ...style, source: '@font-face{src:url(/font.woff2)}' },
      ]),
    /must not load other files/,
  )
})
