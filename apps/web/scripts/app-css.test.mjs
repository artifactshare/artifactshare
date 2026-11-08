// The app build leaves out the utilities only the sandboxed viewers use.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const appRoot = fileURLToPath(new URL('../app', import.meta.url))
const VIEWER_EXCLUSION = "@source not './viewers';\n"

// Builds a stylesheet as if it were app.css, with the app's Tailwind and
// Vite CSS pipeline, and returns the emitted CSS.
async function buildAppCss(source) {
  const stylesheet = resolve(appRoot, '__app-css-under-test.css')
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    mode: 'production',
    root: appRoot,
    publicDir: false,
    plugins: [
      {
        name: 'app-css-under-test',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'virtual:app-css-entry') return '\0app-css-entry'
          if (id === stylesheet) return stylesheet
          return null
        },
        load(id) {
          if (id === '\0app-css-entry')
            return `import ${JSON.stringify(stylesheet)}`
          if (id === stylesheet) return source
          return null
        },
      },
      tailwindcss(),
    ],
    build: {
      write: false,
      minify: true,
      cssCodeSplit: false,
      reportCompressedSize: false,
      rolldownOptions: { input: 'virtual:app-css-entry' },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (entry) => entry.output,
  )
  const css = outputs.filter(
    (output) => output.type === 'asset' && output.fileName.endsWith('.css'),
  )
  assert.equal(css.length, 1)
  return String(css[0].source)
}

const appCss = await readFile(resolve(appRoot, 'app.css'), 'utf8')

test('the app CSS leaves out the utilities only the viewers use', async () => {
  assert.ok(appCss.includes(VIEWER_EXCLUSION))
  // Utilities the PDF viewer uses and no app source does.
  const viewerOnly = /\.w-61\b|\.max-stack\\:h-18\b/
  const [app, scanningViewers] = await Promise.all([
    buildAppCss(appCss),
    buildAppCss(appCss.replace(VIEWER_EXCLUSION, '')),
  ])

  assert.doesNotMatch(app, viewerOnly)
  assert.match(scanningViewers, viewerOnly)
})
