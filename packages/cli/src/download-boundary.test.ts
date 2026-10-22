import assert from 'node:assert/strict'
import { Response } from 'undici'
import * as fs from 'node:fs/promises'
import { dirname, basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  beforeEach,
  afterEach,
  expectTypeOf,
  test,
  vi,
  type TestContext,
} from 'vitest'
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

for (const input of ['ABC123DEF4', `${id} `, ` ${id}`, `${id}\t`, `\n${id}`]) {
  test(`single target rejects unmodified ID ${JSON.stringify(input)} before HTTP or writes`, async (t) => {
    const { base, args } = await fixture(t)
    delete args.options.projectId
    args.positionals = [input]
    serve()
    let mutations = 0
    await runDownload(args, { json: true }, false, {
      checkpoint: async (phase) => {
        if (phase !== 'read') mutations++
      },
    })
    assert.equal(failure().code, 'validation_failed')
    assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
    assert.equal(mutations, 0)
    assert.deepEqual(await fs.readdir(base), [])
  })
}

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
  test(`${single ? 'single' : 'project'} force replaces stale files and reports retained originals`, async (t) => {
    const { base, output, args } = await fixture(t)
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
    assert.equal(data.backup_paths.length, 1)
    const backup = data.backup_paths[0]!
    assert.equal(await fs.readFile(join(backup, 'old'), 'utf8'), 'original')
    assert.deepEqual(
      (await fs.readdir(base)).sort(),
      single ? [basename(dirname(backup)), 'output'].sort() : ['output'],
    )
    assert.equal(dirname(dirname(backup)), single ? base : output)
    const { writeSuccess: renderSuccess } =
      await vi.importActual<typeof import('./output.js')>('./output.js')
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      renderSuccess('download', data, { json: false })
      assert.ok(
        stdout.mock.calls
          .map(([text]) => String(text))
          .join('')
          .includes(`Original data retained at ${backup}`),
      )
    } finally {
      stdout.mockRestore()
    }
  })
}

for (const force of [false, true]) {
  test(`project publishes on the output filesystem (force=${force})`, async (t) => {
    const { base, output, args } = await fixture(t)
    await fs.mkdir(output)
    const oldIndex = JSON.stringify({ artifacts: [{ id, version_id: 'old' }] })
    if (force) {
      await fs.mkdir(join(output, id))
      await fs.writeFile(join(output, id, 'old'), 'original')
      await fs.writeFile(join(output, 'index.json'), oldIndex)
    }
    args.options.force = force
    serve()
    const insideOutput = (path: string) => {
      const child = relative(output, path)
      return child !== '..' && !child.startsWith(`..${sep}`)
    }
    const renames: Array<[string, string]> = []
    const indexTemps: string[] = []
    await runDownload(args, { json: true }, false, {
      checkpoint: async (phase, path) => {
        if (phase === 'create' && path.endsWith('.tmp')) indexTemps.push(path)
      },
      rename: async (source, destination) => {
        // Model output as a mount point: its descendants share a device,
        // while a workspace in output's parent is on another device.
        if (insideOutput(String(source)) !== insideOutput(String(destination)))
          throw Object.assign(new Error('Cross-device rename'), {
            code: 'EXDEV',
          })
        renames.push([String(source), String(destination)])
        await fs.rename(source, destination)
      },
    })
    assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
    const data = vi.mocked(writeSuccess).mock.calls.at(-1)![1] as {
      ok: number
      failed: number
      backup_paths: string[]
    }
    assert.equal(data.ok, 1)
    assert.equal(data.failed, 0)
    assert.equal(renames.length, force ? 4 : 2)
    assert.ok(renames.flat().every(insideOutput))
    assert.equal(indexTemps.length, 1)
    const workspace = dirname(indexTemps[0]!)
    assert.equal(dirname(workspace), output)
    assert.match(basename(workspace), /^\.artifactshare-/)
    assert.equal(
      await fs.readFile(join(output, id, 'index.md'), 'utf8'),
      '# abc',
    )
    const index = JSON.parse(
      await fs.readFile(join(output, 'index.json'), 'utf8'),
    )
    assert.deepEqual(
      index.artifacts.map((item: { id: string }) => item.id),
      [id],
    )
    assert.deepEqual(await fs.readdir(base), ['output'])
    assert.equal(data.backup_paths.length, force ? 2 : 0)
    if (force) {
      assert.ok(data.backup_paths.every((path) => dirname(path) === workspace))
      assert.equal(
        await fs.readFile(join(data.backup_paths[0]!, 'old'), 'utf8'),
        'original',
      )
      assert.equal(await fs.readFile(data.backup_paths[1]!, 'utf8'), oldIndex)
      assert.deepEqual(
        (await fs.readdir(workspace)).sort(),
        data.backup_paths.map((path) => basename(path)).sort(),
      )
    } else {
      await assert.rejects(fs.lstat(workspace), { code: 'ENOENT' })
    }
  })
}

test('incremental run skips content and retains previous index backup', async (t) => {
  const { output, args } = await fixture(t)
  serve()
  await runDownload(args, { json: true })
  assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
  const indexPath = join(output, 'index.json')
  const oldIndex = (await fs.stat(indexPath)).ino
  const oldContent = await fs.readFile(indexPath, 'utf8')
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
  assert.equal(data.backup_paths.length, 1)
  assert.equal((await fs.stat(data.backup_paths[0]!)).ino, oldIndex)
  assert.equal(await fs.readFile(data.backup_paths[0]!, 'utf8'), oldContent)
  assert.notEqual((await fs.stat(indexPath)).ino, oldIndex)
})

for (const target of ['root', 'index']) {
  test(`download refuses linked ${target} with force`, async (t) => {
    const { base, output, args } = await fixture(t)
    const outside = join(base, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'sentinel'), 'unchanged')
    if (target === 'root') await fs.symlink(outside, output)
    if (target === 'index') {
      await fs.mkdir(output)
      await fs.symlink(join(outside, 'sentinel'), join(output, 'index.json'))
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

test('failed index publication restores old index without a stale recovery hint', async (t) => {
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
  assert.doesNotMatch(error.hint, /Recover retained data at/)
  assert.ok(!JSON.stringify(error).includes('private failure'))
  assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), index)
})

test('empty workspace cleanup failure does not advertise retained data', async (t) => {
  const { output, args } = await fixture(t)
  serve()
  await runDownload(args, { json: true }, false, {
    rmdir: async () => {
      throw new Error('private cleanup failure')
    },
  })
  assert.doesNotMatch(failure().hint, /Recover retained data at/)
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
  'https://ABC123DEF4.artifactshare.link',
  'https://a-ABC123DEF4--v-7631.artifactshareusercontent.com',
]) {
  test(`single download resolves normalized target ${input}`, async (t) => {
    const { base, args } = await fixture(t)
    delete args.options.projectId
    args.positionals = [input]
    serve()
    await runDownload(args, { json: true })
    assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
    assert.equal(vi.mocked(cliFetch).mock.calls.length, 2)
    assert.deepEqual(await fs.readdir(base), ['output'])
  })
}

for (const paths of [
  ['/../outside/sentinel'],
  ['relative.md'],
  ['/assets\\file.md'],
  ['/assets\0file.md'],
]) {
  for (const force of [false, true]) {
    for (const priorIndex of [false, true]) {
      test(`project continues after unsafe manifest ${JSON.stringify(paths)} (force=${force}, index=${priorIndex})`, async (t) => {
        const { base, output, args } = await fixture(t)
        const outside = join(base, 'outside')
        await fs.mkdir(outside)
        await fs.writeFile(join(outside, 'sentinel'), 'keep')
        await fs.mkdir(output)
        const index = '{"artifacts":[]}\n'
        if (priorIndex) await fs.writeFile(join(output, 'index.json'), index)
        args.options.force = force
        serve([entry(id), entry(otherId)])
        const fetch = vi.mocked(cliFetch).getMockImplementation()!
        vi.mocked(cliFetch).mockImplementation(async (url, options) => {
          if (String(url).endsWith(`/${id}/download`)) {
            const body = manifest()
            body.files = paths.map((path) => ({ ...body.files[0]!, path }))
            return json(body)
          }
          return fetch(url, options)
        })
        await runDownload(args, { json: true })
        assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
        assert.equal(process.exitCode, 1)
        const results = JSON.parse(
          await fs.readFile(join(output, 'index.json'), 'utf8'),
        )
        assert.equal(results.artifacts[0].status, 'failed')
        assert.ok(
          results.artifacts[0].reason.includes(JSON.stringify(paths.at(-1))),
        )
        assert.match(results.artifacts[0].reason, /retry|Retry/)
        assert.equal(results.artifacts[1].status, 'ok')
        assert.equal(
          await fs.readFile(join(output, otherId, 'index.md'), 'utf8'),
          '# abc',
        )
        await assert.rejects(fs.lstat(join(output, id)), { code: 'ENOENT' })
        assert.deepEqual(await fs.readdir(outside), ['sentinel'])
        assert.equal(
          await fs.readFile(join(outside, 'sentinel'), 'utf8'),
          'keep',
        )
      })
    }
  }
}

for (const bad of ['identity', 'malformed', 'ABC123DEF4', '../x', 123, null]) {
  test(`project handles artifact ${bad} failure according to its boundary status`, async (t) => {
    const { base, output, args } = await fixture(t)
    const outside = join(base, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'sentinel'), 'keep')
    await fs.mkdir(output)
    args.options.force = true
    serve([entry(id), entry(otherId)])
    const fetch = vi.mocked(cliFetch).getMockImplementation()!
    vi.mocked(cliFetch).mockImplementation(async (url, options) => {
      if (String(url).endsWith(`/${id}/download`)) {
        if (bad === 'malformed') return json({ files: [] })
        return json(manifest(bad === 'identity' ? otherId : bad))
      }
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
    assert.equal(process.exitCode, 1)
    const index = JSON.parse(
      await fs.readFile(join(output, 'index.json'), 'utf8'),
    )
    assert.equal(index.artifacts[0].status, 'failed')
    assert.equal(index.artifacts[1].status, 'ok')
    assert.equal(
      await fs.readFile(join(output, otherId, 'index.md'), 'utf8'),
      '# abc',
    )
    await assert.rejects(fs.lstat(join(output, id)), { code: 'ENOENT' })
    assert.deepEqual(await fs.readdir(outside), ['sentinel'])
    assert.equal(await fs.readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
  })
}

for (const [single, force] of [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const) {
  test(`${single ? 'single' : 'project'} download accepts a linked output parent (force=${force})`, async (t) => {
    expectTypeOf(single).toEqualTypeOf<boolean>()
    expectTypeOf(force).toEqualTypeOf<boolean>()
    const { base, args } = await fixture(t)
    const parent = join(base, 'actual')
    const alias = join(base, 'alias')
    await fs.mkdir(parent)
    await fs.symlink(parent, alias)
    args.options.output = join(alias, 'output')
    if (single) {
      delete args.options.projectId
      args.positionals = [id]
    }
    args.options.force = force
    serve()
    await runDownload(args, { json: true })
    assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
    assert.equal(vi.mocked(writeSuccess).mock.calls.length, 1)
    const artifact = single
      ? join(parent, 'output')
      : join(parent, 'output', id)
    assert.equal(await fs.readFile(join(artifact, 'index.md'), 'utf8'), '# abc')
    if (!single) {
      const index = JSON.parse(
        await fs.readFile(join(parent, 'output', 'index.json'), 'utf8'),
      )
      assert.equal(index.artifacts[0].status, 'ok')
    }
  })
}

test('project rejects links in unchanged artifact contents without inspecting unrelated trees', async (t) => {
  const { base, output, args } = await fixture(t)
  serve()
  await runDownload(args, { json: true })
  const outside = join(base, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, 'sentinel'), 'keep')
  await fs.symlink(outside, join(output, 'node_modules'))
  await fs.symlink(outside, join(output, '.git'))
  await fs.symlink(outside, join(output, id, 'unrelated'))
  vi.clearAllMocks()
  serve()
  const visited: string[] = []
  await runDownload(args, { json: true }, false, {
    lstat: async (path) => {
      visited.push(path)
      return fs.lstat(path, { bigint: true })
    },
  })
  assert.equal(failure().code, 'validation_failed')
  assert.ok(failure().message.includes(join(output, id, 'unrelated')))
  assert.ok(visited.includes(join(output, id, 'unrelated')))
  for (const name of ['.git', 'node_modules'])
    assert.ok(!visited.includes(join(output, name)))
  assert.equal(await fs.readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
  assert.deepEqual((await fs.readdir(base)).sort(), ['output', 'outside'])
})

test('project aborts publication when an artifact destination changes during staging', async (t) => {
  const { base, output, args } = await fixture(t)
  const root = join(output, id)
  const outside = join(base, 'outside')
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(join(root, 'old'), 'original')
  await fs.mkdir(outside)
  await fs.writeFile(join(outside, 'sentinel'), 'keep')
  const oldIndex = JSON.stringify({ artifacts: [{ id, version_id: 'old' }] })
  await fs.writeFile(join(output, 'index.json'), oldIndex)
  args.options.force = true
  serve([entry(id), entry(otherId)])
  let swapped = false
  await runDownload(args, { json: true }, false, {
    checkpoint: async (phase, path) => {
      if (swapped || phase !== 'create' || !path.endsWith('/index.md')) return
      swapped = true
      await fs.rename(root, join(base, 'original'))
      await fs.symlink(outside, root)
    },
  })
  assert.equal(swapped, true)
  assert.equal(failure().code, 'validation_failed')
  await assert.rejects(fs.lstat(join(output, otherId)), { code: 'ENOENT' })
  assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), oldIndex)
  assert.ok(
    !vi
      .mocked(cliFetch)
      .mock.calls.some(([url]) => String(url).includes(`/${otherId}/download`)),
  )
  assert.equal(
    await fs.readFile(join(base, 'original', 'old'), 'utf8'),
    'original',
  )
  assert.deepEqual(await fs.readdir(outside), ['sentinel'])
  assert.equal(await fs.readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
})

for (const force of [false, true]) {
  for (const kind of ['markdown_page', 'spa']) {
    test(`project rejects a non-directory destination before staging (force=${force}, kind=${kind})`, async (t) => {
      const { base, output, args } = await fixture(t)
      await fs.mkdir(output)
      await fs.writeFile(join(output, id), 'original')
      const index = JSON.stringify({
        artifacts: [{ id, version_id: 'version' }],
      })
      await fs.writeFile(join(output, 'index.json'), index)
      args.options.force = force
      // A valid earlier entry must not be written before the later refusal.
      serve([entry(otherId), { ...entry(id), artifact_kind: kind }])
      let mutations = 0
      await runDownload(args, { json: true }, false, {
        checkpoint: async (phase) => {
          if (phase !== 'read') mutations++
        },
      })
      assert.equal(failure().code, 'validation_failed')
      assert.ok(failure().message.includes(join(output, id)))
      assert.equal(mutations, 0)
      assert.equal(vi.mocked(writeSuccess).mock.calls.length, 0)
      assert.equal(vi.mocked(cliFetch).mock.calls.length, 1)
      assert.equal(await fs.readFile(join(output, id), 'utf8'), 'original')
      assert.equal(await fs.readFile(join(output, 'index.json'), 'utf8'), index)
      assert.deepEqual(
        (await fs.readdir(output)).sort(),
        [id, 'index.json'].sort(),
      )
      assert.deepEqual(await fs.readdir(base), ['output'])
    })
  }
}

for (const force of [false, true]) {
  test(`project rejects a plain artifact file before any mutation (force=${force})`, async (t) => {
    const { base, output, args } = await fixture(t)
    await fs.mkdir(output)
    await fs.writeFile(join(output, id), 'keep')
    args.options.force = force
    // A valid first entry must not be written before a later unsafe output.
    serve([entry(otherId), entry(id)])
    let mutations = 0
    await runDownload(args, { json: true }, false, {
      checkpoint: async (phase) => {
        if (phase !== 'read') mutations++
      },
    })
    assert.equal(failure().code, 'validation_failed')
    assert.ok(failure().message.includes(join(output, id)))
    assert.equal(mutations, 0)
    assert.equal(vi.mocked(cliFetch).mock.calls.length, 1)
    assert.deepEqual(await fs.readdir(base), ['output'])
    assert.deepEqual(await fs.readdir(output), [id])
    assert.equal(await fs.readFile(join(output, id), 'utf8'), 'keep')
  })
}

for (const body of [null, [], 'invalid', {}, { files: [] }]) {
  test(`single malformed manifest is a service error: ${JSON.stringify(body)}`, async (t) => {
    const { base, args } = await fixture(t)
    delete args.options.projectId
    args.positionals = [id]
    vi.mocked(cliFetch).mockResolvedValue(json(body))
    let mutations = 0
    await runDownload(args, { json: true }, false, {
      checkpoint: async () => {
        mutations++
      },
    })
    assert.equal(failure().code, 'service_error')
    assert.equal(mutations, 0)
    assert.deepEqual(await fs.readdir(base), [])
  })
}

for (const paths of [
  ['/index.md', '/index.md'],
  ['/index.md', '/index.md/child'],
  ['/index.md/child', '/index.md'],
  ...(process.platform === 'darwin' || process.platform === 'win32'
    ? [['/About.html', '/about.html']]
    : []),
]) {
  for (const force of [false, true]) {
    test(`project continues after manifest conflict ${JSON.stringify(paths)} (force=${force})`, async (t) => {
      const { output, args } = await fixture(t)
      args.options.force = force
      await fs.mkdir(output)
      await fs.writeFile(join(output, 'index.json'), '{"artifacts":[]}')
      serve([entry(id), entry(otherId)])
      const fetch = vi.mocked(cliFetch).getMockImplementation()!
      vi.mocked(cliFetch).mockImplementation(async (url, options) => {
        if (String(url).endsWith(`/${id}/download`)) {
          const body = manifest()
          body.files = paths.map((path) => ({ ...body.files[0]!, path }))
          return json(body)
        }
        return fetch(url, options)
      })
      await runDownload(args, { json: true })
      assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
      assert.equal(process.exitCode, 1)
      const index = JSON.parse(
        await fs.readFile(join(output, 'index.json'), 'utf8'),
      )
      assert.equal(index.artifacts[0].status, 'failed')
      assert.match(index.artifacts[0].reason, /conflicting file path/)
      assert.equal(index.artifacts[1].status, 'ok')
      assert.equal(
        await fs.readFile(join(output, otherId, 'index.md'), 'utf8'),
        '# abc',
      )
      await assert.rejects(fs.lstat(join(output, id)), { code: 'ENOENT' })
    })
  }
}

test('failed cleanup reports a workspace containing staged data', async (t) => {
  const { args } = await fixture(t)
  delete args.options.projectId
  args.positionals = [id]
  serve()
  await runDownload(args, { json: true }, false, {
    rename: async () => {
      throw new Error('publication failed')
    },
    unlink: async () => {
      throw new Error('cleanup failed')
    },
  })
  assert.match(failure().hint, /Recover retained data at/)
})
