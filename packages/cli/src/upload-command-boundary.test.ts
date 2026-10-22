import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Response } from 'undici'
import { tmpdir } from 'node:os'
import { runShare } from './command-runners/share.js'
import { runUpdate } from './command-runners/update.js'
import { runAppend } from './command-runners/append.js'
import { resolveCredential } from './credentials.js'
import { cliFetch } from './api.js'
import { writeFailure, writeSuccess } from './output.js'
import type { ParsedArgs } from './types.js'
import type { UploadBoundaryOptions } from './upload-boundary.js'

const boundaryHooks = vi.hoisted(() => ({}) as UploadBoundaryOptions)
vi.mock('./upload-boundary.js', async (original) => {
  const boundary = await original<typeof import('./upload-boundary.js')>()
  return {
    ...boundary,
    prepareUpload: (input: string, type: (name: string) => string) =>
      boundary.prepareUpload(input, type, boundaryHooks),
    prepareAppend: (input: string) =>
      boundary.prepareAppend(input, boundaryHooks),
  }
})

vi.mock('./credentials.js', () => ({ resolveCredential: vi.fn() }))
vi.mock('./output.js', () => ({
  writeFailure: vi.fn(),
  writeSuccess: vi.fn(),
  updateSuccessFields: vi.fn(() => true),
}))
vi.mock('./destination.js', async (original) => ({
  ...(await original<typeof import('./destination.js')>()),
  resolveProjectConfig: vi.fn(async () => ({ config: {} })),
  resolveSharedProjectConfig: vi.fn(async () => ({ config: {} })),
  resolveDefaultVisibility: vi.fn(async () => ({ value: 'workspace' })),
}))
vi.mock('./api.js', async (original) => ({
  ...(await original<typeof import('./api.js')>()),
  cliFetch: vi.fn(),
  apiGet: vi.fn(async (route, _token, _options, init) => {
    const response = await cliFetch(
      new URL(route, 'https://artifactshare.test'),
      init,
    )
    if ('networkError' in response)
      throw new Error('Unexpected network failure')
    return response.ok
      ? { body: await response.json() }
      : { error: { code: 'token_invalid' } }
  }),
}))
vi.mock('./command-runners/auto-login.js', () => ({
  handleCredentialFailure: vi.fn(
    async (_command, _error, _options, _mode, retry) => retry(),
  ),
  handleAuthenticatedCredentialFailure: vi.fn(
    async (_command, _error, _credential, _options, _mode, retry, isRetry) => {
      if (isRetry) throw new Error('Unexpected second auth retry')
      return retry()
    },
  ),
}))

let root: string
let selected: string
let reads: string[]
const runners = { share: runShare, update: runUpdate, append: runAppend }
beforeEach(async () => {
  vi.clearAllMocks()
  delete boundaryHooks.checkpoint
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'upload-command-')),
  )
  selected = path.join(root, 'selected')
  await fs.mkdir(selected)
  await fs.writeFile(path.join(selected, 'index.html'), '<h1>original</h1>')
  await fs.writeFile(path.join(root, 'outside.html'), 'outside sentinel')
  reads = []
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const read = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementation(
        (...readArgs: Parameters<typeof handle.readFile>) => {
          reads.push(String(args[0]))
          return read(...readArgs)
        },
      )
      return handle
    },
  )
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'env',
  })
})
afterEach(async () => {
  expect(reads).not.toContain(path.join(root, 'outside.html'))
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
function commandArgs(command: keyof typeof runners, input: string): ParsedArgs {
  return {
    command,
    positionals: command === 'share' ? [input] : ['abc123def4', input],
    options: command === 'share' ? { project: 'Example', key: 'report' } : {},
  }
}
for (const command of Object.keys(runners) as Array<keyof typeof runners>) {
  test.each([
    'file-link',
    'directory-link',
    'dangling',
    'parent-link',
    'escape',
    'invalid',
    'descendant',
  ])(
    '%s: ' + command + ' rejects before credentials/project/network',
    async (kind) => {
      const outside = path.join(root, 'outside.html')
      let input = path.join(selected, 'link')
      let reason = 'link'
      if (kind === 'file-link') await fs.symlink(outside, input, 'file')
      if (kind === 'directory-link') await fs.symlink(root, input, 'junction')
      if (kind === 'dangling')
        await fs.symlink(path.join(root, 'missing'), input, 'file')
      if (kind === 'parent-link') {
        await fs.symlink(root, input, 'junction')
        input = 'link/outside.html'
        vi.spyOn(process, 'cwd').mockReturnValue(selected)
      }
      if (kind === 'escape') {
        input = '../outside.html'
        reason = 'escape'
        vi.spyOn(process, 'cwd').mockReturnValue(selected)
      }
      if (kind === 'invalid') {
        input = `${selected}/index.html/../index.html`
        reason = 'invalid'
      }
      if (kind === 'descendant') {
        await fs.symlink(outside, input, 'file')
        input = selected
        if (command === 'append') reason = 'type'
      }
      await runners[command](commandArgs(command, input), { json: true })
      expect(writeFailure).toHaveBeenCalledWith(
        command,
        expect.objectContaining({ details: { reason } }),
        { json: true },
        1,
      )
      expect(resolveCredential).not.toHaveBeenCalled()
      expect(cliFetch).not.toHaveBeenCalled()
      expect(reads).toEqual([])
    },
  )
  for (const recovery of ['credential', 'upload', 'project'] as const) {
    if (recovery === 'project' && command !== 'share') continue
    test(`${command} ${recovery} recovery reuses verified bytes`, async () => {
      const input = path.join(selected, 'index.html')
      const parsed = commandArgs(command, input)
      const bodies: string[] = []
      let failed = false
      if (recovery === 'credential') {
        vi.mocked(resolveCredential).mockImplementationOnce(async () => {
          await fs.rm(input)
          return { ok: false, error: { code: 'auth_required' } } as Awaited<
            ReturnType<typeof resolveCredential>
          >
        })
      }
      vi.mocked(cliFetch).mockImplementation(async (url, init) => {
        const project = String(url).includes('/projects')
        if (init?.body) {
          if (typeof init.body === 'string') bodies.push(init.body)
          else {
            const form = init.body as import('undici').FormData
            for (const value of form.getAll('file')) {
              if (typeof value !== 'string') bodies.push(await value.text())
            }
          }
        }
        if (
          !failed &&
          (recovery === 'project' ? project : recovery === 'upload' && !project)
        ) {
          failed = true
          await fs.rm(input)
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
          })
        }
        return new Response(
          JSON.stringify(
            project
              ? {
                  projects: [{ id: 'prj1', name: 'Example', updated_at: null }],
                }
              : {
                  id: 'abc123def4',
                  shareUrl: 'https://artifactshare.test/a/abc123def4',
                  artifactKind: 'html_page',
                  versionId: 'ver1',
                },
          ),
          { status: 200 },
        )
      })
      await runners[command](parsed, { json: true })
      expect(writeFailure).not.toHaveBeenCalled()
      expect(writeSuccess).toHaveBeenCalled()
      expect(reads).toEqual([input])
      expect(bodies.length).toBe(recovery === 'upload' ? 2 : 1)
      for (const body of bodies) expect(body).toContain('<h1>original</h1>')
      expect(await fs.stat(input).catch(() => null)).toBeNull()
    })
  }
}

for (const command of Object.keys(runners) as Array<keyof typeof runners>) {
  for (const stage of [
    'enumerated',
    'beforeOpen',
    'afterOpen',
    'afterRead',
  ] as const) {
    for (const parent of [false, true]) {
      for (const link of [false, true]) {
        test(`${command} refuses ${parent ? 'parent' : 'leaf'} ${link ? 'link' : 'identity'} swap at ${stage} before any request`, async (context) => {
          const input = path.join(selected, 'index.html')
          let mutated = false
          let refused: string | undefined
          // Relative file selections include the selected directory in their boundary.
          vi.spyOn(process, 'cwd').mockReturnValue(root)
          boundaryHooks.checkpoint = async (point) => {
            if (point !== stage || mutated || refused) return
            const victim = parent ? selected : input
            try {
              await fs.rename(victim, victim + '-old')
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (
                process.platform !== 'win32' ||
                !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
              )
                throw error
              refused = code
              return
            }
            if (link)
              await fs.symlink(
                parent ? root : path.join(root, 'outside.html'),
                victim,
                parent ? 'junction' : 'file',
              )
            else if (parent) await fs.mkdir(victim)
            else await fs.writeFile(victim, '<h1>original</h1>')
            mutated = true
          }
          if (process.platform === 'win32') {
            // An OS-refused mutation leaves valid input. Do not let the mock auth retry loop obscure it.
            vi.mocked(resolveCredential).mockImplementation(async () => {
              throw new Error('Platform refused mutation')
            })
          }
          const thrown = await runners[command](
            commandArgs(command, path.join('selected', 'index.html')),
            { json: true },
          ).catch((error) => error)
          if (refused) {
            expect(process.platform).toBe('win32')
            expect(['EPERM', 'EACCES', 'EBUSY']).toContain(refused)
            expect(mutated).toBe(false)
            expect(thrown).toBeInstanceOf(Error)
            context.skip(
              'skipped-by-platform: Windows refused the open-file swap',
            )
          }
          expect(mutated).toBe(true)
          expect(thrown).toBeUndefined()
          expect(writeFailure).toHaveBeenCalledWith(
            command,
            expect.objectContaining({
              details: { reason: link ? 'link' : 'changed' },
            }),
            { json: true },
            1,
          )
          expect(resolveCredential).not.toHaveBeenCalled()
          expect(cliFetch).not.toHaveBeenCalled()
          expect(reads).toHaveLength(stage === 'afterRead' ? 1 : 0)
        })
      }
    }
  }
}

test.each([Buffer.from([0xff]), Buffer.alloc(0)])(
  'append validates encoding and nonempty content before authentication',
  async (bytes) => {
    const input = path.join(selected, 'index.html')
    await fs.writeFile(input, bytes)
    await runAppend(commandArgs('append', input), { json: true })
    expect(writeFailure).toHaveBeenCalledWith(
      'append',
      expect.objectContaining({
        code: 'validation_failed',
        message: bytes.length
          ? 'File is not valid UTF-8.'
          : 'Path must be a non-empty file.',
      }),
      { json: true },
      1,
    )
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(cliFetch).not.toHaveBeenCalled()
  },
)

for (const command of ['share', 'update'] as const) {
  test.each(['markdown', 'static_site'] as const)(
    `${command} retains %s bytes and metadata on upload retry`,
    async (kind) => {
      const markdown = path.join(selected, 'report.md')
      if (kind === 'markdown') await fs.writeFile(markdown, '# Original')
      else
        await fs.writeFile(
          path.join(selected, 'theme.css'),
          'body { color: black }',
        )
      const input = kind === 'markdown' ? markdown : selected
      const parsed = commandArgs(command, input)
      parsed.options =
        command === 'share'
          ? {
              projectId: 'prj1',
              key: 'report',
              visibility: 'link',
              grantEmail: ['person@example.com'],
              noSlackNotify: true,
              expectedVersion: 'ver0',
            }
          : { label: 'Revision', expectedVersion: 'ver0' }
      let requests = 0
      const contents: Array<
        Array<{ name: string; type: string; text: string }>
      > = []
      vi.mocked(cliFetch).mockImplementation(async (url, init) => {
        requests++
        const query = new URL(url).searchParams
        expect(query.get('expected_version')).toBe('ver0')
        if (kind === 'static_site')
          expect(query.get('artifact_kind')).toBe('static_site')
        const form = init!.body as import('undici').FormData
        if (command === 'share') {
          expect(query.get('publish_key')).toBe('report')
          expect(form.getAll('grant_email')).toEqual(['person@example.com'])
          expect(form.getAll('visibility')).toEqual(['link'])
          expect(form.getAll('container_id')).toEqual(['prj1'])
          expect(form.getAll('slack_notify')).toEqual(['false'])
        } else expect(query.get('label')).toBe('Revision')
        const files = []
        for (const value of form.getAll('file')) {
          if (typeof value === 'string') throw new Error('Expected a file')
          files.push({
            name: value.name,
            type: value.type,
            text: await value.text(),
          })
        }
        contents.push(files)
        if (requests === 1) {
          await fs.rm(input, { recursive: true })
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
          })
        }
        return new Response(
          JSON.stringify({
            id: 'abc123def4',
            shareUrl: 'https://artifactshare.test/a/abc123def4',
            versionId: 'ver1',
            artifactKind: kind === 'markdown' ? 'markdown_page' : kind,
          }),
        )
      })
      await runners[command](parsed, { json: true })
      expect(writeFailure).not.toHaveBeenCalled()
      expect(writeSuccess).toHaveBeenCalled()
      expect(requests).toBe(2)
      const expected =
        kind === 'markdown'
          ? [{ name: 'report.md', type: 'text/markdown', text: '# Original' }]
          : [
              {
                name: 'index.html',
                type: 'text/html',
                text: '<h1>original</h1>',
              },
              {
                name: 'theme.css',
                type: 'text/css',
                text: 'body { color: black }',
              },
            ]
      expect(contents).toEqual([expected, expected])
      expect(reads).toHaveLength(expected.length)
      expect(new Set(reads).size).toBe(expected.length)
    },
  )
}
