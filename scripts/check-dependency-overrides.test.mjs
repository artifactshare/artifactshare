import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAllDocuments, stringify } from 'yaml'
import { analyzeDependencyOverrides } from './check-dependency-overrides.mjs'
import {
  inspectTree,
  loadBoundaryManifest,
} from './public-development-guard.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const selector = 'vite@8.3.3>rolldown'
const contexts = [
  'vite@8.3.3(@types/node@22.0.0)',
  'vite@8.3.3(@types/node@24.0.0)',
]
const action =
  /re-test the D1 suite \(`pnpm test:d1`\) and update or remove the override/u

test('repository boundary includes the dependency checker and its tests', () => {
  const paths = [
    'scripts/check-dependency-overrides.mjs',
    'scripts/check-dependency-overrides.test.mjs',
  ]
  assert.deepEqual(
    inspectTree(paths, loadBoundaryManifest(root)),
    paths.map((path) => ({ path, classification: 'canonical' })),
  )
})

function fixture() {
  return {
    workspace: { overrides: { [selector]: '1.2.14' } },
    lock: {
      importers: { '.': {}, 'apps/web': {} },
      overrides: { [selector]: '1.2.14' },
      packages: {
        'vite@8.3.3': {},
        'rolldown@1.2.8': {},
        'rolldown@1.2.14': {},
      },
      snapshots: {
        [contexts[0]]: { dependencies: { rolldown: '1.2.14' } },
        [contexts[1]]: { dependencies: { rolldown: '1.2.14' } },
        'vite-plus@0.3.1': { dependencies: { rolldown: '1.2.8' } },
      },
    },
  }
}
function sources({ workspace, lock }) {
  return [
    stringify(workspace),
    `lockfileVersion: '9.0'\npackages:\n  pnpm@12.4.1: {}\n---\n${stringify(lock)}`,
  ]
}
function rejects(data, diagnostic) {
  assert.throws(
    () => analyzeDependencyOverrides(...sources(data)),
    (error) => {
      assert.match(error.message, diagnostic)
      assert.match(error.message, action)
      return true
    },
  )
}

test('accepts two lock documents, both Vite contexts and unrelated rolldown', () => {
  assert.match(
    analyzeDependencyOverrides(...sources(fixture())),
    /2 Vite snapshots/u,
  )
})

test('rejects a workspace-only selector change with unchanged lock metadata', () => {
  const data = fixture()
  data.workspace.overrides = { 'vite@8.3.4>rolldown': '1.2.14' }
  rejects(data, /metadata.*vite@8.3.4>rolldown/u)
})

test('rejects a resolved Vite upgrade with a stale selector', () => {
  const data = fixture()
  data.lock.packages = { 'vite@8.3.4': {} }
  rejects(data, /vite@8.3.4.*vite@8.3.3>rolldown/u)
})

test('checks the second peer context for broken rolldown independently of metadata', () => {
  const data = fixture()
  data.lock.snapshots[contexts[1]].dependencies.rolldown = '1.2.15'
  rejects(data, /node@24.0.0.*broken rolldown@1.2.15/u)
})

for (const missing of [
  'override',
  'lock override',
  'packages',
  'snapshots',
  'edge',
]) {
  test(`fails closed with missing ${missing}`, () => {
    const data = fixture()
    if (missing === 'override') data.workspace.overrides = {}
    if (missing === 'lock override') delete data.lock.overrides
    if (missing === 'packages') delete data.lock.packages
    if (missing === 'snapshots') delete data.lock.snapshots
    if (missing === 'edge')
      delete data.lock.snapshots[contexts[1]].dependencies.rolldown
    rejects(data, /pnpm-(?:workspace|lock).yaml/u)
  })
}

test('executable reports policy, YAML and missing-input errors, and succeeds read-only', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dependency-overrides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const workspacePath = join(directory, 'pnpm-workspace.yaml')
  const lockPath = join(directory, 'pnpm-lock.yaml')
  const run = () =>
    spawnSync(
      process.execPath,
      [join(root, 'scripts/check-dependency-overrides.mjs'), directory],
      { encoding: 'utf8', cwd: directory },
    )
  const [workspace, lock] = sources(fixture())
  writeFileSync(workspacePath, workspace)
  writeFileSync(lockPath, lock)
  const passed = run()
  assert.equal(passed.status, 0, passed.stderr)
  assert.match(passed.stdout, /Dependency overrides check ok/u)
  assert.equal(readFileSync(workspacePath, 'utf8'), workspace)
  assert.equal(readFileSync(lockPath, 'utf8'), lock)
  writeFileSync(workspacePath, workspace.replace('8.3.3', '8.3.4'))
  const mismatch = run()
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, action)
  writeFileSync(workspacePath, workspace)
  writeFileSync(
    lockPath,
    lock.replace(/      rolldown: 1.2.14/gu, '      rolldown: 1.2.15'),
  )
  const broken = run()
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /broken rolldown@1.2.15/u)
  assert.match(broken.stderr, action)
  for (const path of [workspacePath, lockPath]) {
    writeFileSync(workspacePath, workspace)
    writeFileSync(lockPath, lock)
    writeFileSync(path, '[invalid')
    const malformed = run()
    assert.equal(malformed.status, 1)
    assert.match(
      malformed.stderr,
      /pnpm-(?:workspace|lock).yaml: repair invalid YAML/u,
    )
  }
  rmSync(workspacePath)
  const missing = run()
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /pnpm-workspace.yaml: restore a readable input/u)
})

test('real exceptions and scoped sharp override match resolved package identities', () => {
  const workspaceSource = readFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'utf8',
  )
  const lockSource = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  assert.match(
    analyzeDependencyOverrides(workspaceSource, lockSource),
    /check ok/u,
  )
  const workspace = parseAllDocuments(workspaceSource)[0].toJS()
  const lock = parseAllDocuments(lockSource)
    .map((doc) => doc.toJS())
    .find((doc) => doc.importers?.['apps/web'])
  const retained = [
    'miniflare@5.20260911.0-alpha',
    'wrangler@4.131.1',
    '@cloudflare/vite-plugin@1.54.8',
    '@tanstack/highlight@0.1.0',
    '@tanstack/markdown@0.0.14',
    'happy-dom@20.14.5',
    'yaml@2.9.1',
  ]
  assert.deepEqual(workspace.minimumReleaseAgeExclude, retained)
  const removed = [
    '@better-fetch/fetch@1.2.2',
    'better-call@1.3.6',
    '@cloudflare/workers-types@5.20260827.1',
    'miniflare@5.20260826.0-alpha',
    'miniflare@5.20260907.0-alpha',
    'wrangler@4.129.1',
    '@cloudflare/vite-plugin@1.54.1',
  ]
  for (const name of [
    'workerd',
    ...[
      'darwin-64',
      'darwin-arm64',
      'linux-64',
      'linux-arm64',
      'windows-64',
    ].map((platform) => `@cloudflare/workerd-${platform}`),
  ])
    for (const version of ['1.20260826.1', '1.20260907.1'])
      removed.push(`${name}@${version}`)
  for (const records of [lock.packages, lock.snapshots]) {
    const identities = new Set(
      Object.keys(records).map((key) => key.split('(')[0]),
    )
    for (const identity of retained)
      assert.ok(identities.has(identity), identity)
    for (const identity of removed)
      assert.ok(!identities.has(identity), identity)
  }
  for (const config of [workspace, lock]) {
    assert.equal(config.overrides['sharp@>=0.34.0 <0.35.5'], undefined)
    assert.equal(config.overrides['miniflare>sharp@>=0.34.0 <0.35.5'], '0.35.5')
  }
  const miniflare = Object.entries(lock.snapshots).filter(([key]) =>
    key.startsWith('miniflare@'),
  )
  assert.ok(miniflare.length)
  for (const [, snapshot] of miniflare)
    assert.equal(snapshot.dependencies.sharp.split('(')[0], '0.35.5')
})
