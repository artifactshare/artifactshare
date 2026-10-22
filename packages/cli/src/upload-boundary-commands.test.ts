import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test, vi, beforeEach, type TestContext } from 'vitest'
import { Response, type FormData } from 'undici'
import { runShare } from './command-runners/share.js'
import { runAppend } from './command-runners/append.js'
import { runUpdate } from './command-runners/update.js'
import { resolveCredential } from './credentials.js'
import { resolveProjectConfig } from './destination.js'
import { cliFetch } from './api.js'
import { writeFailure, writeSuccess } from './output.js'
import {
  prepareUploadSelection,
  type UploadBoundaryDependencies,
} from './upload-boundary.js'
import type { CliOptions } from './types.js'

const hooks = vi.hoisted(() => ({
  dependencies: {} as UploadBoundaryDependencies,
  projectLookup: vi.fn(),
}))
vi.mock('./upload-boundary.js', async (original) => {
  const actual = await original<typeof import('./upload-boundary.js')>()
  return {
    ...actual,
    prepareUploadSelection: vi.fn((input: string, single = false) =>
      actual.prepareUploadSelection(input, single, hooks.dependencies),
    ),
  }
})
vi.mock('./command-runners/projects.js', () => ({
  fetchProjects: hooks.projectLookup,
}))
vi.mock('./credentials.js', () => ({ resolveCredential: vi.fn() }))
vi.mock('./destination.js', async (original) => ({
  ...(await original<typeof import('./destination.js')>()),
  resolveProjectConfig: vi.fn(async () => ({ config: null })),
  resolveSharedProjectConfig: vi.fn(async () => ({ config: null })),
  resolveDefaultVisibility: vi.fn(async () => ({ value: 'workspace' })),
}))
vi.mock('./api.js', async (original) => ({
  ...(await original<typeof import('./api.js')>()),
  cliFetch: vi.fn(),
}))
vi.mock('./output.js', async (original) => ({
  ...(await original<typeof import('./output.js')>()),
  writeFailure: vi.fn(),
  writeSuccess: vi.fn(),
}))
// Exercise the commands' actual retry callbacks without using any credential store.
vi.mock('./command-runners/auto-login.js', () => ({
  handleCredentialFailure: vi.fn(
    async (_command, _credential, _options, _mode, retry, isRetry) => {
      assert.equal(isRetry, false)
      return retry()
    },
  ),
  handleAuthenticatedCredentialFailure: vi.fn(
    async (_command, _error, _credential, _options, _mode, retry, isRetry) => {
      assert.equal(isRetry, false)
      return retry()
    },
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  hooks.dependencies = {}
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'env',
  })
  vi.mocked(cliFetch).mockImplementation(async () => {
    throw new Error('unexpected request')
  })
})

async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'upload-commands-')),
  )
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'selected')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'report.html'), '<p>verified</p>')
  const outside = path.join(root, 'outside.html')
  await fs.writeFile(outside, 'outside sentinel')
  hooks.dependencies.cwd = cwd
  return { root, cwd, outside }
}
const runners = { share: runShare, append: runAppend, update: runUpdate }
function invoke(
  command: keyof typeof runners,
  input: string,
  options: CliOptions = {},
) {
  return runners[command](
    {
      command,
      positionals: command === 'share' ? [input] : ['abc123def4', input],
      options: { baseUrl: 'http://127.0.0.1', ...options },
    },
    { json: true },
  )
}

for (const command of ['share', 'append', 'update'] as const) {
  for (const variant of [
    'file',
    'directory',
    'parent',
    'descendant',
    'directory-descendant',
    'dangling',
    'traversal',
    'missing',
  ] as const) {
    test(`${command} rejects ${variant} before credentials or requests and never reads sentinel`, async (t) => {
      const { root, cwd, outside } = await fixture(t)
      const directory =
        variant === 'directory' ||
        variant === 'parent' ||
        variant === 'directory-descendant'
      if (variant !== 'traversal' && variant !== 'missing') {
        try {
          await fs.symlink(
            variant === 'dangling'
              ? path.join(root, 'absent')
              : directory
                ? root
                : outside,
            path.join(cwd, 'link'),
            directory ? 'junction' : 'file',
          )
        } catch (error) {
          if (process.platform !== 'win32') throw error
          assert.ok(
            ['EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code!,
            ),
          )
          t.skip('Windows refused link creation')
        }
      }
      const input =
        variant === 'traversal'
          ? 'report.html/../outside.html'
          : variant === 'missing'
            ? 'missing.html'
            : variant === 'parent'
              ? 'link/outside.html'
              : variant === 'descendant' ||
                  variant === 'directory-descendant' ||
                  variant === 'dangling'
                ? '.'
                : 'link'
      const open = vi.fn(async () => {
        throw new Error('must not read sentinel')
      })
      hooks.dependencies.open = open
      await invoke(
        command,
        input,
        command === 'share' ? { project: 'Example' } : {},
      )
      assert.equal(open.mock.calls.length, 0)
      assert.equal(vi.mocked(resolveCredential).mock.calls.length, 0)
      assert.equal(vi.mocked(resolveProjectConfig).mock.calls.length, 0)
      assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
      const error = vi.mocked(writeFailure).mock.calls[0]![1]
      assert.equal(error.code, 'validation_failed')
      assert.equal(
        error.details?.reason,
        variant === 'traversal'
          ? 'parent_traversal'
          : variant === 'missing'
            ? 'not_found'
            : command === 'append' && input === '.'
              ? 'invalid_type'
              : 'link',
      )
      assert.ok(typeof error.details?.path === 'string')
      assert.ok(error.message.includes(String(error.details.path)))
    })
  }
  for (const retryAt of ['credential', 'response'] as const) {
    test(`${command} ${retryAt} retry reuses one verified read after source deletion`, async (t) => {
      const { cwd } = await fixture(t)
      const target = path.join(cwd, 'report.html')
      let reads = 0
      hooks.dependencies.open = async (...args) => {
        const handle = await fs.open(...args)
        const read = handle.readFile.bind(handle)
        handle.readFile = (() => {
          reads++
          return read()
        }) as typeof handle.readFile
        return handle
      }
      if (retryAt === 'credential') {
        vi.mocked(resolveCredential).mockImplementationOnce(async () => {
          await fs.rm(target)
          return {
            ok: false,
            source: 'none',
            error: { code: 'auth_required' },
          } as Awaited<ReturnType<typeof resolveCredential>>
        })
      }
      const contents: string[] = []
      vi.mocked(cliFetch).mockImplementation(async (_url, init) => {
        if (typeof init?.body === 'string')
          contents.push(JSON.parse(init.body).content)
        else {
          const file = (init!.body as FormData).get('file')
          assert.ok(file && typeof file !== 'string')
          contents.push(await file.text())
        }
        if (retryAt === 'response' && contents.length === 1) {
          await fs.rm(target)
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
          })
        }
        return new Response(
          JSON.stringify({
            id: 'abc123def4',
            versionId: 'v1',
            number: 2,
            label: null,
            shareUrl: 'http://127.0.0.1/a/abc123def4',
            artifactKind: 'html_page',
          }),
        )
      })
      await invoke(
        command,
        'report.html',
        command === 'share' ? { home: true, key: 'report' } : {},
      )
      assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
      assert.equal(vi.mocked(writeSuccess).mock.calls.length, 1)
      assert.equal(vi.mocked(prepareUploadSelection).mock.calls.length, 1)
      assert.equal(reads, 1)
      assert.deepEqual(
        contents,
        retryAt === 'response'
          ? ['<p>verified</p>', '<p>verified</p>']
          : ['<p>verified</p>'],
      )
    })
  }
}

test('share project lookup retry reuses prepared content', async (t) => {
  const { cwd } = await fixture(t)
  let lookups = 0
  hooks.projectLookup.mockImplementation(async () => {
    if (++lookups === 1) {
      await fs.rm(path.join(cwd, 'report.html'))
      return { error: { code: 'token_invalid' } }
    }
    return { projects: [{ id: 'abc123def4', name: 'Example' }] }
  })
  vi.mocked(cliFetch).mockImplementation(async (_url, init) => {
    const file = (init!.body as FormData).get('file')
    assert.ok(file && typeof file !== 'string')
    assert.equal(await file.text(), '<p>verified</p>')
    return new Response(
      JSON.stringify({
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
      }),
    )
  })
  await invoke('share', 'report.html', { project: 'Example' })
  assert.equal(lookups, 2)
  assert.equal(vi.mocked(prepareUploadSelection).mock.calls.length, 1)
  assert.equal(vi.mocked(writeSuccess).mock.calls.length, 1)
})

for (const command of ['share', 'append', 'update'] as const) {
  for (const phase of ['before_open', 'after_open', 'after_read'] as const) {
    test(`${command} refuses an observed ${phase} link swap before any request`, async (t) => {
      const { cwd, outside } = await fixture(t)
      const target = path.join(cwd, 'report.html')
      // Probe link support before any open-handle replacement.
      const probe = path.join(cwd, 'probe')
      try {
        await fs.symlink(outside, probe, 'file')
      } catch (error) {
        if (process.platform !== 'win32') throw error
        assert.ok(
          ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!),
        )
        t.skip('Windows refused link creation')
      }
      await fs.rm(probe)
      let swapped = false
      let refused = false
      let reads = 0
      hooks.dependencies.open = async (...args) => {
        const handle = await fs.open(...args)
        const read = handle.readFile.bind(handle)
        handle.readFile = (() => {
          reads++
          return read()
        }) as typeof handle.readFile
        return handle
      }
      hooks.dependencies.checkpoint = async (at) => {
        if (at !== phase) return
        try {
          await fs.rename(target, `${target}-old`)
        } catch (error) {
          if (process.platform !== 'win32') throw error
          assert.ok(
            ['EPERM', 'EACCES', 'EBUSY'].includes(
              (error as NodeJS.ErrnoException).code!,
            ),
          )
          refused = true
          throw error
        }
        await fs.symlink(outside, target, 'file')
        swapped = true
      }
      await invoke(command, 'report.html')
      if (refused) {
        assert.equal(swapped, false)
        t.skip('Windows refused replacement of an open file')
      }
      assert.equal(swapped, true)
      const error = vi.mocked(writeFailure).mock.calls[0]![1]
      assert.equal(error.details?.reason, 'link')
      assert.equal(error.details?.path, 'report.html')
      assert.equal(reads, phase === 'after_read' ? 1 : 0)
      assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
      assert.equal(vi.mocked(resolveCredential).mock.calls.length, 0)
    })
  }
}

for (const command of ['share', 'update'] as const) {
  for (const kind of ['markdown', 'static_site'] as const) {
    test(`${command} preserves ${kind} multipart names and metadata`, async (t) => {
      const { cwd } = await fixture(t)
      await fs.writeFile(path.join(cwd, 'index.md'), '# verified')
      await fs.mkdir(path.join(cwd, 'dist'))
      await fs.writeFile(path.join(cwd, 'dist', 'app.js'), 'selected script')
      const sent: string[] = []
      vi.mocked(cliFetch).mockImplementation(async (url, init) => {
        const form = init!.body as FormData
        for (const value of form.getAll('file')) {
          assert.ok(typeof value !== 'string')
          sent.push(value.name)
        }
        const query = new URL(url).searchParams
        if (kind === 'static_site')
          assert.equal(query.get('artifact_kind'), 'static_site')
        if (command === 'share')
          assert.equal(query.get('publish_key'), 'report')
        else {
          assert.equal(query.get('label'), 'Updated report')
          assert.equal(query.get('expected_version'), 'v1')
        }
        return new Response(
          JSON.stringify({
            id: 'abc123def4',
            versionId: 'v2',
            artifactKind: kind === 'markdown' ? 'markdown_page' : kind,
          }),
        )
      })
      await invoke(
        command,
        kind === 'markdown' ? 'index.md' : '.',
        command === 'share'
          ? { home: true, key: 'report' }
          : { label: 'Updated report', expectedVersion: 'v1' },
      )
      assert.equal(vi.mocked(writeFailure).mock.calls.length, 0)
      assert.equal(vi.mocked(writeSuccess).mock.calls.length, 1)
      assert.deepEqual(
        sent,
        kind === 'markdown'
          ? ['index.md']
          : ['dist/app.js', 'index.md', 'report.html'],
      )
    })
  }
}

for (const command of ['share', 'append', 'update'] as const) {
  for (const input of ['x:d/link/outside.html', 'x:/outside.html']) {
    test(`${command} bounds POSIX colon-prefixed input ${input} before opening or authentication`, async (t) => {
      if (process.platform === 'win32') t.skip('Colon-prefixed POSIX names')
      const { root, cwd } = await fixture(t)
      if (input.startsWith('x:d/')) {
        await fs.mkdir(path.join(cwd, 'x:d'))
        await fs.symlink(root, path.join(cwd, 'x:d', 'link'), 'dir')
      } else {
        await fs.symlink(root, path.join(cwd, 'x:'), 'dir')
      }
      const open = vi.fn(async () => {
        throw new Error('Outside sentinel must not be opened')
      })
      hooks.dependencies.open = open
      await invoke(
        command,
        input,
        command === 'share' ? { project: 'Example' } : {},
      )
      assert.equal(open.mock.calls.length, 0)
      assert.equal(vi.mocked(resolveCredential).mock.calls.length, 0)
      assert.equal(vi.mocked(resolveProjectConfig).mock.calls.length, 0)
      assert.equal(hooks.projectLookup.mock.calls.length, 0)
      assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
      assert.equal(vi.mocked(writeSuccess).mock.calls.length, 0)
      const error = vi.mocked(writeFailure).mock.calls[0]![1]
      assert.equal(error.code, 'validation_failed')
      assert.equal(error.details?.reason, 'link')
      assert.equal(error.details?.path, input)
      assert.ok(error.message.includes(input))
      assert.match(error.hint, /absolute path/)
    })
  }
}

for (const command of ['share', 'append', 'update'] as const) {
  test(`${command} rejects an unreported directory redirect before auth or reads`, async (t) => {
    const { cwd, root } = await fixture(t)
    const entry = path.join(cwd, 'assets')
    const target = path.join(root, 'external')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'index.html'), 'outside sentinel')
    let inspected = false
    let reads = 0
    hooks.dependencies.lstat = async (name) => {
      if (name === entry) {
        inspected = true
        return fs.lstat(target, { bigint: true })
      }
      return fs.lstat(name, { bigint: true })
    }
    hooks.dependencies.realpath = async (name) =>
      name === entry ? target : fs.realpath(name)
    hooks.dependencies.open = async () => {
      reads++
      throw new Error('outside content must not be read')
    }
    await invoke(command, 'assets')
    assert.equal(inspected, true)
    assert.equal(reads, 0)
    assert.equal(vi.mocked(writeFailure).mock.calls.length, 1)
    const error = vi.mocked(writeFailure).mock.calls[0]![1]
    assert.equal(error.code, 'validation_failed')
    assert.equal(error.details?.reason, 'link')
    assert.equal(error.details?.path, 'assets')
    assert.equal(vi.mocked(resolveCredential).mock.calls.length, 0)
    assert.equal(vi.mocked(resolveProjectConfig).mock.calls.length, 0)
    assert.equal(hooks.projectLookup.mock.calls.length, 0)
    assert.equal(vi.mocked(cliFetch).mock.calls.length, 0)
  })
}
