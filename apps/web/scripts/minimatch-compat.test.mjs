import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const doctorRequire = createRequire(
  realpathSync(join(root, 'node_modules/react-doctor/package.json')),
)
const deslopDirectory = dirname(doctorRequire.resolve('deslop-js/package.json'))
const hooksRequire = createRequire(
  doctorRequire.resolve('eslint-plugin-react-hooks'),
)
const shadcnRequire = createRequire(
  realpathSync(join(root, 'apps/web/node_modules/shadcn/package.json')),
)

function fixture(t) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'minimatch-compat-')),
  )
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function write(directory, file, body) {
  const target = join(directory, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}

for (const format of ['esm', 'cjs']) {
  test(`deslop ${format} cached glob selection agrees with uncached analysis`, async (t) => {
    const directory = fixture(t)
    const project = join(directory, 'project')
    write(project, 'package.json', JSON.stringify({ type: 'module' }))
    write(
      project,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['src/**/*.ts'],
      }),
    )
    write(
      project,
      'src/main.ts',
      'import { used } from "./nested/used.js"; console.log(used)',
    )
    write(project, 'src/nested/used.ts', 'export const used = 1')
    write(project, 'src/orphan.ts', 'export const orphan = 2')
    write(project, 'src/ignored/noise.ts', 'export const ignored = 3')
    write(project, 'src/.hidden.ts', 'export const hidden = 4')
    const api =
      format === 'esm'
        ? await import(
            pathToFileURL(join(deslopDirectory, 'dist/index.mjs')).href
          )
        : doctorRequire('deslop-js')
    const config = api.defineConfig({
      rootDir: project,
      entryPatterns: ['src/{main,secondary}.ts'],
      ignorePatterns: ['**/ignored/**', '**/.*'],
      reportRedundancy: false,
      reportCodeQuality: false,
    })
    const cold = await api.analyze(config)
    const cachedConfig = {
      ...config,
      incrementalCachePath: join(directory, 'cache.json'),
    }
    const first = await api.analyze(cachedConfig)
    const warm = await api.analyze(cachedConfig)
    for (const result of [cold, first, warm]) {
      assert.deepEqual(result.analysisErrors, [])
      assert.equal(result.totalFiles, 3)
      assert.deepEqual(
        result.unusedFiles
          .map(({ path }) => relative(project, path).split(sep).join('/'))
          .sort(),
        ['src/orphan.ts'],
      )
    }
    assert.ok(warm.incrementalCacheStats.summaryHits > 0)
  })

  test(`deslop ${format} falls back for literal hash-prefixed entry patterns`, async (t) => {
    const directory = fixture(t)
    const project = join(directory, 'project')
    write(project, 'package.json', JSON.stringify({ type: 'module' }))
    write(project, 'tsconfig.json', JSON.stringify({ include: ['*.ts'] }))
    write(project, '#entry.ts', 'console.log("entry")')
    write(project, 'orphan.ts', 'export const orphan = 1')
    const api =
      format === 'esm'
        ? await import(
            pathToFileURL(join(deslopDirectory, 'dist/index.mjs')).href
          )
        : doctorRequire('deslop-js')
    const config = api.defineConfig({
      rootDir: project,
      entryPatterns: ['#entry.ts'],
      reportRedundancy: false,
      reportCodeQuality: false,
    })
    const cold = await api.analyze(config)
    const cachedConfig = {
      ...config,
      incrementalCachePath: join(directory, 'cache.json'),
    }
    await api.analyze(cachedConfig)
    const warm = await api.analyze(cachedConfig)
    for (const result of [cold, warm]) {
      assert.deepEqual(result.analysisErrors, [])
      assert.equal(result.totalFiles, 2)
      assert.deepEqual(
        result.unusedFiles.map(({ path }) => relative(project, path)),
        ['orphan.ts'],
      )
    }
  })
}

test('ESLint glob discovery and config ignores preserve selected files and diagnostics', async (t) => {
  const directory = fixture(t)
  write(directory, 'src/main.js', 'const unused = 1')
  write(directory, 'src/nested/helper.mjs', 'export const used = 1')
  write(directory, 'src/ignored/noise.js', 'const ignored = 1')
  const { ESLint } = hooksRequire('eslint')
  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ['src/ignored/**'] },
      { files: ['src/**/*.{js,mjs}'], rules: { 'no-unused-vars': 'error' } },
    ],
  })
  const results = await eslint.lintFiles(['src/**/*.{js,mjs}'])
  assert.deepEqual(
    results
      .map(({ filePath }) => relative(directory, filePath).split(sep).join('/'))
      .sort(),
    ['src/main.js', 'src/nested/helper.mjs'],
  )
  assert.deepEqual(
    results.flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId)),
    ['no-unused-vars'],
  )
})

test('ts-morph in-memory glob discovery preserves braces and negated directories', () => {
  const { Project } = shadcnRequire('ts-morph')
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
  })
  const filesystem = project.getFileSystem()
  filesystem.writeFileSync('/src/main.ts', 'export const main = 1')
  filesystem.writeFileSync('/src/nested/view.tsx', 'export const view = 1')
  filesystem.writeFileSync('/src/ignored/noise.ts', 'export const ignored = 1')
  const files = project.addSourceFilesAtPaths([
    '/src/**/*.{ts,tsx}',
    '!/src/ignored/**',
  ])
  assert.deepEqual(files.map((file) => file.getFilePath()).sort(), [
    '/src/main.ts',
    '/src/nested/view.tsx',
  ])
})
