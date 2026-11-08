import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  pickBundle,
  renderViewer,
  viewers,
  writeViewer,
} from './build-viewers.mjs'

const rendered = {
  pdf: renderViewer('pdf'),
  video: renderViewer('video'),
}

for (const name of Object.keys(viewers)) {
  test(`rebuilds the committed ${name} script and stylesheet byte for byte`, async () => {
    const first = await rendered[name]
    const second = await renderViewer(name)

    assert.equal(second.sources.script, first.sources.script)
    assert.equal(second.sources.style, first.sources.style)
    await writeViewer(first, { check: true })
  })

  test(`check mode rejects a missing or stale ${name} script or stylesheet without writing`, async () => {
    const bundle = await rendered[name]
    const directory = await mkdtemp(join(tmpdir(), `${name}-viewer-`))
    try {
      const outputs = {
        script: join(directory, 'script.generated.ts'),
        style: join(directory, 'style.generated.ts'),
      }
      await assert.rejects(
        writeViewer(bundle, { outputs, check: true }),
        /script\.generated\.ts is missing or stale/,
      )
      await assert.rejects(stat(outputs.script), { code: 'ENOENT' })
      await writeViewer(bundle, { outputs })
      await writeViewer(bundle, { outputs, check: true })
      for (const kind of ['script', 'style']) {
        const current = await readFile(outputs[kind], 'utf8')
        const stale = current.replace('export const', 'export  const')
        await writeFile(outputs[kind], stale)
        await assert.rejects(
          writeViewer(bundle, { outputs, check: true }),
          new RegExp(`${kind}\\.generated\\.ts is missing or stale`),
        )
        assert.equal(await readFile(outputs[kind], 'utf8'), stale)
        await writeFile(outputs[kind], current)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('each viewer bundles only its own strings and its own run-time files', async () => {
  const pdf = await rendered.pdf
  const video = await rendered.video

  // pdf.js loads at run time from the sandbox origin, not from the bundle.
  assert.match(pdf.script, /\/__as_pdf\/pdfjs\//)
  assert.doesNotMatch(pdf.script, /__as_video/)
  assert.match(video.script, /\/__as_video\/original\.mp4/)
  assert.doesNotMatch(video.script, /__as_pdf/)
  // Labels each viewer shows, in both languages, and none of the other's.
  assert.ok(pdf.script.includes('PDF controls'))
  assert.ok(!pdf.script.includes('Playback settings'))
  assert.ok(video.script.includes('Playback settings'))
  assert.ok(video.script.includes('再生設定'))
  assert.ok(!video.script.includes('PDF controls'))
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
