// Checks that the app's built stylesheet is byte for byte the one a base
// commit builds. The viewers build their own stylesheets from shared sources
// (the theme, the UI components, the i18n catalogs the app also scans), so a
// viewer change must not add, drop or reorder anything in the app's CSS.
//
//   node apps/web/scripts/check-viewer-app-css.mjs --base <commit>
//
// The base commit's apps/web/app is extracted into a temporary directory
// inside apps/web, so its stylesheet resolves the same installed packages,
// and both stylesheets are built with the same Vite and Tailwind CSS
// pipeline. Nothing in the checkout changes and no server is needed.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = resolve(webRoot, '../..')
export const currentAppRoot = resolve(webRoot, 'app')

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', options.stdout ?? 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', fail)
    child.on('close', (code) =>
      code === 0
        ? done()
        : fail(new Error(`${command} ${args.join(' ')} failed: ${stderr}`)),
    )
  })
}

// Builds app.css from an app source directory the way the app build does:
// Tailwind scans that directory, Vite processes and minifies the result.
export async function buildAppCss(appRoot) {
  const stylesheet = resolve(appRoot, 'app.css')
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    mode: 'production',
    root: appRoot,
    publicDir: false,
    plugins: [
      {
        name: 'app-css-entry',
        enforce: 'pre',
        resolveId(id) {
          return id === 'virtual:app-css-entry' ? '\0app-css-entry' : null
        },
        load(id) {
          return id === '\0app-css-entry'
            ? `import ${JSON.stringify(stylesheet)}`
            : null
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
  if (css.length !== 1)
    throw new Error(`expected one app stylesheet, got ${css.length}`)
  return String(css[0].source)
}

// Runs `use` with the given commit's apps/web/app extracted into a
// temporary directory, removed afterwards.
export async function withCommitApp(commit, use) {
  const directory = await mkdtemp(join(webRoot, '.app-css-base-'))
  try {
    const archive = join(directory, 'app.tar')
    await run('git', [
      'archive',
      '--format=tar',
      `--output=${archive}`,
      commit,
      'apps/web/app',
    ])
    await run('tar', ['-xf', archive, '-C', directory])
    await rm(archive)
    return await use(join(directory, 'apps/web/app'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Compares the app CSS built from the base commit with the one built from
// the current sources (by default the working tree's apps/web/app).
export async function compareAppCss({ base, currentRoot = currentAppRoot }) {
  const [baseCss, currentCss] = await Promise.all([
    withCommitApp(base, buildAppCss),
    buildAppCss(currentRoot),
  ])
  return { same: baseCss === currentCss, baseCss, currentCss }
}

function firstDifference(a, b) {
  let index = 0
  while (index < a.length && a[index] === b[index]) index += 1
  return index
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--base')
  const base = flag === -1 ? undefined : process.argv[flag + 1]
  if (!base) {
    console.error('usage: check-viewer-app-css.mjs --base <commit>')
    process.exit(2)
  }
  try {
    const { same, baseCss, currentCss } = await compareAppCss({ base })
    if (same) {
      console.log(
        `The app CSS is identical to ${base} (${Buffer.byteLength(currentCss)} bytes).`,
      )
    } else {
      const at = firstDifference(baseCss, currentCss)
      console.error(
        `The app CSS differs from ${base} (${Buffer.byteLength(baseCss)} → ${Buffer.byteLength(currentCss)} bytes), first at ${at}:\n` +
          `  base:    ${JSON.stringify(baseCss.slice(Math.max(0, at - 80), at + 80))}\n` +
          `  current: ${JSON.stringify(currentCss.slice(Math.max(0, at - 80), at + 80))}`,
      )
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
