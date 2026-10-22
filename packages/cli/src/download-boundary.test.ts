import assert from 'node:assert/strict'
import { Response } from 'undici'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, test, vi, type TestContext } from 'vitest'
import { runDownload } from './command-runners/download.js'
import { cliFetch } from './api.js'
import { writeFailure, writeSuccess } from './output.js'
import type { ParsedArgs } from './types.js'

vi.mock('./api.js', async (original) => ({
  ...(await original<typeof import('./api.js')>()),
  cliFetch: vi.fn(),
}))
vi.mock('./credentials.js', () => ({
  resolveCredential: async () => ({
    ok: true,
    token: 'fixture',
    source: 'env',
  }),
}))
vi.mock('./destination.js', async (original) => ({
  ...(await original<typeof import('./destination.js')>()),
  resolveProjectConfig: async () => ({ config: null }),
}))
vi.mock('./output.js', async (original) => ({
  ...(await original<typeof import('./output.js')>()),
  writeFailure: vi.fn(),
  writeSuccess: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  process.exitCode = 0
})
const id = 'abc123def4'
const otherId = 'html123abc'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })
const entry = (artifactId: unknown) => ({
  id: artifactId,
  title: 'Report',
  share_url: 'https://example.test/a/abc123def4',
  visibility: 'workspace',
  updated_at: '2026-01-01T00:00:00Z',
  project_id: 'project',
  artifact_kind: 'markdown_page',
})
const manifest = (artifactId: unknown = id) => ({
  id: artifactId,
  version_id: 'version',
  share_url: 'https://example.test/a/abc123def4',
  artifact_kind: 'markdown_page',
  files: [
    {
      path: '/index.md',
      size_bytes: 5,
      content_type: 'text/markdown',
      sha256: '',
    },
  ],
  total_size_bytes: 5,
})
async function fixture(t: TestContext) {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'download-boundary-')),
  )
  t.onTestFinished(() => fs.rm(base, { recursive: true, force: true }))
  const output = join(base, 'output')
  const args: ParsedArgs = {
    command: 'download',
    options: { projectId: 'project', output, baseUrl: 'https://example.test' },
    positionals: [],
  }
  return { base, output, args }
}
function serve(entries: unknown[] = [entry(id)]) {
  vi.mocked(cliFetch).mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('project_id='))
      return json({ artifacts: entries, has_more: false, limit: 50 })
    if (url.endsWith('/download'))
      return json(manifest(url.includes(otherId) ? otherId : id))
    return new Response('# abc')
  })
}
function failure() {
  assert.equal(vi.mocked(writeSuccess).mock.calls.length, 0)
  const call = vi.mocked(writeFailure).mock.calls.at(-1)
  assert.ok(call)
  return call[1]
}

for (const shape of ['contract', 'compatibility']) {
  for (const bad of [
    '.',
    '..',
    'a/b',
    'a\\b',
    '/abs',
    'C:x',
    '\\\\server\\x',
    '\0',
    'CON',
    'abc123def.',
    'abc123def ',
    'ABC123DEF4',
    undefined,
    12,
  ]) {
    test(`${shape} list refuses unsafe ID ${JSON.stringify(bad)} before mutation`, async (t) => {
      const { base, args } = await fixture(t)
      const entries = [
        entry(id),
        shape === 'contract' ? entry(bad) : { id: bad },
      ]
      serve(entries)
      let mutations = 0
      await runDownload(args, { json: true }, false, {
        checkpoint: async (phase) => {
          if (phase !== 'read') mutations++
        },
      })
      assert.equal(failure().code, 'validation_failed')
      assert.equal(mutations, 0)
      assert.deepEqual(await fs.readdir(base), [])
    })
  }
}

for (const duplicate of [id, id.toUpperCase()]) {
  test(`rejects ID collision across pages: ${duplicate}`, async (t) => {
    const { base, args } = await fixture(t)
    vi.mocked(cliFetch)
      .mockResolvedValueOnce(
        json({
          artifacts: [entry(id)],
          has_more: true,
          next_cursor: 'next',
          limit: 1,
        }),
      )
      .mockResolvedValueOnce(
        json({ artifacts: [entry(duplicate)], has_more: false, limit: 1 }),
      )
    await runDownload(args, { json: true })
    assert.equal(failure().code, 'validation_failed')
    assert.deepEqual(await fs.readdir(base), [])
  })
}

for (const artifacts of [
  [{ id: '..' }],
  [{ id }, { id }],
  [{ id, version_id: 42 }, { id: '..' }],
  [{ version_id: 'v' }],
]) {
  test(`rejects unsafe index IDs before any write: ${JSON.stringify(artifacts)}`, async (t) => {
    const { output, args } = await fixture(t)
    await fs.mkdir(output)
    const index = JSON.stringify({ artifacts })
    await fs.writeFile(join(output, 'index.json'), index)
    serve([])
    let mutations = 0
    await runDownload(args, { json: true }, false, {
      checkpoint: async (phase) => {
        if (phase !== 'read') mutations++
      },
    })
    assert.equal(failure().code, 'validation_failed')
    assert.equal(mutations, 0)
    assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), index)
    assert.deepEqual(await fs.readdir(output), ['index.json'])
  })
}

test('single target ID validation precedes credentials and HTTP', async (t) => {
  const { base, args } = await fixture(t)
  delete args.options.projectId
  args.positionals = ['ABC123DEF4']
  await runDownload(args, { json: true })
  assert.equal(failure().code, 'validation_failed')
  assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
  assert.deepEqual(await fs.readdir(base), [])
})

for (const manifestId of ['..', otherId]) {
  test(`single manifest identity ${manifestId} fails before staging`, async (t) => {
    const { base, args } = await fixture(t)
    delete args.options.projectId
    args.positionals = [id]
    vi.mocked(cliFetch).mockResolvedValue(json(manifest(manifestId)))
    await runDownload(args, { json: true })
    assert.equal(failure().code, 'validation_failed')
    assert.deepEqual(await fs.readdir(base), [])
  })
}

for (const single of [false, true]) {
  test(`${single ? 'single' : 'project'} force retains originals and replaces stale files`, async (t) => {
    const { output, args } = await fixture(t)
    if (single) {
      delete args.options.projectId
      args.positionals = [id]
    }
    const artifact = single ? output : join(output, id)
    await fs.mkdir(artifact, { recursive: true })
    await fs.writeFile(join(artifact, 'old'), 'original')
    args.options.force = true
    serve()
    await runDownload(args, { json: true })
    assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
    assert.deepEqual(await fs.readdir(artifact), ['index.md'])
    const data = vi.mocked(writeSuccess).mock.calls.at(-1)![1] as {
      backup_paths: string[]
    }
    assert.equal(
      await fs.readFile(join(data.backup_paths[0]!, 'old'), 'utf8'),
      'original',
    )
  })
}

test('incremental run skips content and retains previous index', async (t) => {
  const { output, args } = await fixture(t)
  serve()
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  const oldIndex = await fs.readFile(join(output, 'index.json'), 'utf8')
  vi.clearAllMocks()
  serve()
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  const data = vi.mocked(writeSuccess).mock.calls.at(-1)![1] as {
    unchanged: number
    backup_paths: string[]
  }
  assert.equal(data.unchanged, 1)
  assert.equal(vi.mocked(cliFetch).mock.calls.length, 2)
  assert.equal(await fs.readFile(data.backup_paths[0]!, 'utf8'), oldIndex)
})

for (const target of ['parent', 'root', 'index', 'child']) {
  test(`download refuses linked ${target} with force`, async (t) => {
    const { base, output, args } = await fixture(t)
    const outside = join(base, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'sentinel'), 'unchanged')
    if (target === 'parent') {
      await fs.symlink(outside, output)
      args.options.output = join(output, 'nested')
    }
    if (target === 'root') await fs.symlink(outside, output)
    if (target === 'index' || target === 'child') {
      await fs.mkdir(output)
      await fs.symlink(
        target === 'index' ? join(outside, 'sentinel') : outside,
        join(output, target === 'index' ? 'index.json' : id),
      )
    }
    args.options.force = true
    serve()
    await runDownload(args, { json: true })
    assert.equal(failure().code, 'validation_failed')
    assert.equal(
      await fs.readFile(join(outside, 'sentinel'), 'utf8'),
      'unchanged',
    )
    assert.deepEqual(await fs.readdir(outside), ['sentinel'])
  })
}

test('empty project publishes a regular index and cleans workspace', async (t) => {
  const { base, output, args } = await fixture(t)
  serve([])
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(output, 'index.json'), 'utf8')).artifacts,
    [],
  )
  assert.deepEqual(await fs.readdir(base), ['output'])
})

test('unsupported kinds with valid IDs skip successfully without file requests', async (t) => {
  const { base, output, args } = await fixture(t)
  serve([
    { ...entry(id), artifact_kind: 'spa' },
    { ...entry(otherId), artifact_kind: 'workspace_app' },
  ])
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  assert.equal(process.exitCode, 0)
  const data = vi.mocked(writeSuccess).mock.calls.at(-1)![1] as {
    ok: number
    skipped: number
    failed: number
  }
  assert.equal(data.ok, 0)
  assert.equal(data.skipped, 2)
  assert.equal(data.failed, 0)
  assert.equal(vi.mocked(cliFetch).mock.calls.length, 1)
  const index = JSON.parse(
    await fs.readFile(join(output, 'index.json'), 'utf8'),
  )
  assert.deepEqual(
    index.artifacts.map(
      (artifact: { id: string; status: string; reason: string }) => [
        artifact.id,
        artifact.status,
        artifact.reason,
      ],
    ),
    [
      [id, 'skipped', 'unsupported-kind'],
      [otherId, 'skipped', 'unsupported-kind'],
    ],
  )
  assert.deepEqual(await fs.readdir(output), ['index.json'])
  assert.deepEqual(await fs.readdir(base), ['output'])
})

test('unsupported kinds still reject invalid IDs before mutation', async (t) => {
  const { base, args } = await fixture(t)
  serve([{ ...entry('artspa100011'), artifact_kind: 'spa' }])
  let mutations = 0
  await runDownload(args, { json: true }, false, {
    checkpoint: async (phase) => {
      if (phase !== 'read') mutations++
    },
  })
  assert.equal(failure().code, 'validation_failed')
  assert.equal(mutations, 0)
  assert.deepEqual(await fs.readdir(base), [])
})

test('failed index publication restores old index and reports recovery', async (t) => {
  const { output, args } = await fixture(t)
  await fs.mkdir(output)
  const index = '{"artifacts":[]}'
  await fs.writeFile(join(output, 'index.json'), index)
  serve([])
  let failed = false
  await runDownload(args, { json: true }, false, {
    rename: async (source, destination) => {
      if (!failed && String(destination).endsWith('/index.json')) {
        failed = true
        throw new Error('private failure')
      }
      await fs.rename(source, destination)
    },
  })
  const error = failure()
  assert.equal(error.code, 'download_failed')
  assert.ok(!JSON.stringify(error).includes('private failure'))
  assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), index)
})

test('cleanup failure reports retained workspace without a success envelope', async (t) => {
  const { output, args } = await fixture(t)
  serve()
  await runDownload(args, { json: true }, false, {
    rmdir: async () => {
      throw new Error('private cleanup failure')
    },
  })
  assert.match(failure().hint, /Recover retained data at/)
  assert.ok(!JSON.stringify(failure()).includes('private cleanup failure'))
  assert.equal(await fs.readFile(join(output, id, 'index.md'), 'utf8'), '# abc')
})

test('partial content failure keeps original data and continues ordinary project results', async (t) => {
  const { output, args } = await fixture(t)
  const root = join(output, id)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(join(root, 'original'), 'keep')
  args.options.force = true
  serve([entry(id), entry(otherId)])
  const fetch = vi.mocked(cliFetch).getMockImplementation()!
  vi.mocked(cliFetch).mockImplementation(async (url, options) => {
    if (String(url).includes(`/${id}/download/`)) return json({}, 500)
    return fetch(url, options)
  })
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  const data = vi.mocked(writeSuccess).mock.calls.at(-1)![1] as {
    ok: number
    failed: number
  }
  assert.equal(data.ok, 1)
  assert.equal(data.failed, 1)
  assert.equal(await fs.readFile(join(root, 'original'), 'utf8'), 'keep')
})

for (const input of [
  'abc123def4 ',
  ' abc123def4',
  'https://ABC123DEF4.artifactshare.link',
  'https://a-ABC123DEF4--v-7631.artifactshareusercontent.com',
]) {
  test(`single download does not normalize invalid ID spelling ${input}`, async (t) => {
    const { base, args } = await fixture(t)
    delete args.options.projectId
    args.positionals = [input]
    await runDownload(args, { json: true })
    assert.equal(failure().code, 'validation_failed')
    assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
    assert.deepEqual(await fs.readdir(base), [])
  })
}
