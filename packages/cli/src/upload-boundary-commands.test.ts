import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test, vi, beforeEach, type TestContext } from 'vitest'
import { runShare } from './command-runners/share.js'
import { runAppend } from './command-runners/append.js'
import { runUpdate } from './command-runners/update.js'
import { resolveCredential } from './credentials.js'
import {
  collectBody,
  formParts,
  withServer,
  type FormPart,
} from './test/server.js'
import { type UploadBoundaryDependencies } from './upload-boundary.js'
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

/** Every request the command sent to the stub API, in order. */
let requests: {
  url: string
  method: string | undefined
  parts: FormPart[]
  json: any
}[] = []
/** What the stub API answers; the default accepts one upload. */
let reply: (
  request: (typeof requests)[number],
) =>
  | Promise<{ status?: number; body: unknown }>
  | { status?: number; body: unknown }
let stdout: string
let stderr: string
const defaultReply = () => ({
  body: {
    id: 'abc123def4',
    versionId: 'v1',
    number: 2,
    label: null,
    shareUrl: 'http://127.0.0.1/a/abc123def4',
    artifactKind: 'html_page',
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  hooks.dependencies = {}
  requests = []
  stdout = ''
  stderr = ''
  reply = defaultReply
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'env',
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})

/** The error payload the command printed, or undefined when it succeeded. */
function failure():
  | {
      code: string
      message: string
      hint: string
      details?: Record<string, unknown>
    }
  | undefined {
  if (stderr === '') return undefined
  return JSON.parse(stderr).error
}
function succeeded(): boolean {
  return stdout !== '' && JSON.parse(stdout).ok === true
}

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
async function invoke(
  command: keyof typeof runners,
  input: string,
  options: CliOptions = {},
) {
  await withServer(
    async (request, response) => {
      const body = await collectBody(request)
      const entry = {
        url: request.url ?? '',
        method: request.method,
        parts: formParts(body),
        json: body.startsWith('{') ? JSON.parse(body) : undefined,
      }
      requests.push(entry)
      const { status = 200, body: payload } = await reply(entry)
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(payload))
    },
    async (baseUrl) => {
      await runners[command](
        {
          command,
          positionals: command === 'share' ? [input] : ['abc123def4', input],
          options: { baseUrl, ...options },
        },
        { json: true },
      )
    },
  )
}

/** The uploaded content of each request, however the command framed it. */
const sentContents = () =>
  requests.map((entry) =>
    entry.json
      ? String(entry.json.content)
      : (entry.parts.find((part) => part.name === 'file')?.value ?? ''),
  )

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
      assert.deepEqual(requests, [])
      const error = failure()!
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
      if (retryAt === 'response')
        reply = async (entry) => {
          if (requests.indexOf(entry) > 0) return defaultReply()
          await fs.rm(target)
          return { status: 401, body: { error: 'unauthorized' } }
        }
      await invoke(
        command,
        'report.html',
        command === 'share' ? { home: true, key: 'report' } : {},
      )
      assert.equal(failure(), undefined)
      assert.ok(succeeded())
      assert.equal(reads, 1)
      assert.deepEqual(
        sentContents(),
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
  await invoke('share', 'report.html', { project: 'Example' })
  assert.equal(lookups, 2)
  assert.deepEqual(sentContents(), ['<p>verified</p>'])
  assert.ok(succeeded())
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
      const error = failure()!
      assert.equal(error.details?.reason, 'link')
      assert.equal(error.details?.path, 'report.html')
      assert.equal(reads, phase === 'after_read' ? 1 : 0)
      assert.deepEqual(requests, [])
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
      reply = () => ({
        body: {
          id: 'abc123def4',
          versionId: 'v2',
          artifactKind: kind === 'markdown' ? 'markdown_page' : kind,
        },
      })
      await invoke(
        command,
        kind === 'markdown' ? 'index.md' : '.',
        command === 'share'
          ? { home: true, key: 'report' }
          : { label: 'Updated report', expectedVersion: 'v1' },
      )
      assert.equal(failure(), undefined)
      assert.ok(succeeded())
      assert.equal(requests.length, 1)
      const query = new URL(requests[0]!.url, 'http://127.0.0.1').searchParams
      assert.equal(
        query.get('artifact_kind'),
        kind === 'static_site' ? 'static_site' : null,
      )
      if (command === 'share') assert.equal(query.get('publish_key'), 'report')
      else {
        assert.equal(query.get('label'), 'Updated report')
        assert.equal(query.get('expected_version'), 'v1')
      }
      assert.deepEqual(
        requests[0]!.parts
          .filter((part) => part.name === 'file')
          .map((part) => part.filename),
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
      assert.equal(hooks.projectLookup.mock.calls.length, 0)
      assert.deepEqual(requests, [])
      assert.equal(stdout, '')
      const error = failure()!
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
    const error = failure()!
    assert.equal(error.code, 'validation_failed')
    assert.equal(error.details?.reason, 'link')
    assert.equal(error.details?.path, 'assets')
    assert.equal(vi.mocked(resolveCredential).mock.calls.length, 0)
    assert.equal(hooks.projectLookup.mock.calls.length, 0)
    assert.deepEqual(requests, [])
  })
}
