import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as streams from 'node:fs'
import { Response } from 'undici'
import * as tokenStore from '../token-store.js'
import * as boundary from '../upload-boundary.js'
import * as credentials from '../credentials.js'
import * as output from '../output.js'
import * as api from '../api.js'
import { runShare } from '../command-runners/share.js'
import { runAppend } from '../command-runners/append.js'
import { runUpdate } from '../command-runners/update.js'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  runAsync,
  withServer,
} from './helpers.js'
import { uploadBoundarySwap } from './upload-boundary-swap.js'

// Keep native operations real, but expose configurable exports for read
// observation. Production code has no filesystem bypass or test environment flag.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}))

export function uploadBoundaryRunnerTests(
  command: 'share' | 'append' | 'update',
) {
  for (const kind of [
    'fallback root',
    'repository alias',
    'relative parent',
    'nested repository',
    'aliased nested repository',
    'relative nested marker',
  ]) {
    test(`${command} upload boundary rejects a linked ${kind} before reads or authentication`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'upload-boundary-root-'))
      try {
        const selected = join(root, 'selected')
        const alias = join(root, 'alias')
        await mkdir(selected)
        await writeFile(join(selected, 'index.html'), '<p>selected</p>')
        await symlink(
          selected,
          alias,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
        let input = join(alias, 'index.html')
        let offending = alias
        let cwd = root
        if (kind !== 'fallback root') {
          await mkdir(join(selected, 'site'))
          await writeFile(
            join(selected, 'site', 'index.html'),
            'external-sentinel',
          )
          if (kind.includes('nested'))
            await writeFile(join(selected, 'site', '.git'), 'gitdir: unused')
          if (kind.includes('repository')) {
            const repo = join(root, 'repo')
            await mkdir(repo)
            await mkdir(join(repo, '.git'))
            await symlink(selected, join(repo, 'docs'), 'junction')
            const ancestorAlias = join(root, 'ancestor-alias')
            await symlink(root, ancestorAlias, 'junction')
            if (kind === 'nested repository') {
              input = join('docs', 'site', 'index.html')
              offending = join(repo, 'docs')
            } else {
              input = join(ancestorAlias, 'repo', 'docs', 'site', 'index.html')
              offending = join(ancestorAlias, 'repo', 'docs')
            }
            cwd = repo
          } else {
            input = join('alias', 'site', 'index.html')
          }
        }
        const original = boundary.readUploadBoundary
        vi.spyOn(boundary, 'readUploadBoundary').mockImplementation(
          (path, options) => original(path, { ...options, cwd }),
        )
        let reads = 0
        const originalOpen = fs.open
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await originalOpen(...args)
          const read = handle.readFile.bind(handle)
          handle.readFile = ((
            ...readArgs: Parameters<typeof handle.readFile>
          ) => {
            reads++
            return read(...readArgs)
          }) as typeof handle.readFile
          return handle
        })
        const pathReads = vi.spyOn(fs, 'readFile')
        const pathStreams = vi.spyOn(streams, 'createReadStream')
        const credential = vi.spyOn(credentials, 'resolveCredential')
        const request = vi
          .spyOn(api, 'cliFetch')
          .mockRejectedValue(new Error('Unexpected upload request'))
        const failure = vi
          .spyOn(output, 'writeFailure')
          .mockImplementation(() => undefined)
        await { share: runShare, append: runAppend, update: runUpdate }[
          command
        ](
          {
            command,
            positionals: command === 'share' ? [input] : ['abc123def4', input],
            options: {
              token: 'test-token',
              ...(command === 'share' ? { project: 'example' } : {}),
            },
          },
          { json: true },
        )
        assert.equal(reads, 0)
        for (const [readPath] of pathReads.mock.calls)
          assert.ok(
            ![
              input,
              join(selected, 'index.html'),
              join(selected, 'site', 'index.html'),
            ].includes(String(readPath)),
          )
        assert.equal(pathStreams.mock.calls.length, 0)
        assert.equal(credential.mock.calls.length, 0)
        assert.equal(request.mock.calls.length, 0)
        assert.equal(failure.mock.calls.length, 1)
        const error = failure.mock.calls[0]![1]
        assert.match(error.message, /symbolic link|junction/)
        assert.ok(error.message.includes(offending))
        assert.match(error.hint, /Copy|link target/)
        assert.doesNotMatch(
          JSON.stringify(error),
          /test-token|external-sentinel|<p>/,
        )
      } finally {
        vi.restoreAllMocks()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
  for (const directory of command === 'append' ? [false] : [false, true]) {
    test(`${command} upload boundary uploads verified ${directory ? 'static-site directory' : 'regular file'} bytes`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'upload-boundary-success-'))
      try {
        const site = join(root, 'site')
        await mkdir(site)
        await writeFile(join(site, 'index.html'), '<p>selected upload</p>')
        await writeFile(join(site, '.hidden'), 'excluded-content')
        await mkdir(join(site, 'node_modules'))
        await writeFile(
          join(site, 'node_modules', 'dependency.js'),
          'excluded-content',
        )
        let requests = 0
        await withServer(
          async (request, response) => {
            requests++
            const body = await collectBody(request)
            if (command === 'append') {
              assert.equal(JSON.parse(body).content, '<p>selected upload</p>')
            } else {
              assert.ok(body.includes('<p>selected upload</p>'))
              assert.ok(body.includes('filename="index.html"'))
              assert.ok(body.includes('Content-Type: text/html'))
              assert.ok(!body.includes('excluded-content'))
            }
            response.setHeader('content-type', 'application/json')
            response.end(
              JSON.stringify({
                id: 'abc123def4',
                versionId: 'version2',
                artifactKind: directory ? 'static_site' : 'html_page',
                shareUrl: 'https://example.test/a/abc123def4',
              }),
            )
          },
          async (baseUrl) => {
            const input = directory ? site : join(site, 'index.html')
            const args =
              command === 'share'
                ? [command, input, '--home']
                : [command, 'abc123def4', input]
            const result = await runAsync(
              [...args, '--base-url', baseUrl, '--json'],
              { ARTIFACTSHARE_TOKEN: 'test-token' },
            )
            expectSuccess(result, command)
          },
        )
        assert.equal(requests, 1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
  for (const parent of [false, true]) {
    test(`${command} upload boundary reuses verified bytes after a ${parent ? 'parent' : 'leaf'} replaced during authentication refresh`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'upload-boundary-retry-'))
      try {
        const selected = join(root, 'selected')
        const external = join(root, 'external')
        await mkdir(selected)
        await mkdir(external)
        await mkdir(join(selected, '.git'))
        const path = join(selected, 'index.html')
        const sentinel = join(external, 'index.html')
        await writeFile(path, '<p>selected</p>')
        await writeFile(sentinel, 'external-sentinel')
        const selectedIdentity = await fs.stat(path, { bigint: true })
        const readIdentities: Array<{ dev: bigint; ino: bigint }> = []
        const originalOpen = fs.open
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await originalOpen(...args)
          const read = handle.readFile.bind(handle)
          handle.readFile = (async (
            ...readArgs: Parameters<typeof handle.readFile>
          ) => {
            const { dev, ino } = await handle.stat({ bigint: true })
            readIdentities.push({ dev, ino })
            return read(...readArgs)
          }) as typeof handle.readFile
          return handle
        })
        const pathReads = vi.spyOn(fs, 'readFile')
        const pathStreams = vi.spyOn(streams, 'createReadStream')
        const original = boundary.readUploadBoundary
        const preparations = vi
          .spyOn(boundary, 'readUploadBoundary')
          .mockImplementation((input, options) =>
            original(input, { ...options, cwd: selected }),
          )
        const credential = vi
          .spyOn(credentials, 'resolveCredential')
          .mockResolvedValue({
            ok: true,
            token: 'test-token',
            source: 'profile',
            profile: 'example',
            profileCredentialKind: 'session',
            refreshToken: 'test-refresh-token',
          })
        vi.spyOn(tokenStore, 'readProfileToken').mockResolvedValue({
          ok: true,
          token: 'test-token',
          store: 'plaintext_file',
          credential: {
            kind: 'session',
            session_token: 'test-token',
            refresh_token: 'test-refresh-token',
            expires_at: '2026-01-01T00:00:00.000Z',
          },
        })
        vi.spyOn(tokenStore, 'probeTokenStoreWritable').mockResolvedValue(true)
        vi.spyOn(tokenStore, 'saveProfileSessionCredential').mockResolvedValue({
          ok: true,
          store: 'plaintext_file',
        })
        let uploadCount = 0
        const uploads = vi
          .spyOn(api, 'cliFetch')
          .mockImplementation(async (_url, init) => {
            // Every attempt contains only the verified original bytes.
            if (command === 'append')
              assert.equal(
                JSON.parse(String(init?.body)).content,
                '<p>selected</p>',
              )
            else {
              const form = init?.body as import('undici').FormData
              const file = form.get('file')
              assert.ok(file && typeof file !== 'string')
              assert.equal(await file.text(), '<p>selected</p>')
              assert.equal(file.name, 'index.html')
              assert.equal(file.type, 'text/html')
              if (command === 'share') {
                assert.deepEqual(form.getAll('grant_email'), [
                  'reader@example.test',
                ])
                assert.equal(form.get('visibility'), 'private')
              }
            }
            if (++uploadCount === 2)
              return new Response(
                JSON.stringify({
                  id: 'abc123def4',
                  versionId: 'version2',
                  artifactKind: 'html_page',
                  shareUrl: 'https://example.test/a/abc123def4',
                }),
                { headers: { 'content-type': 'application/json' } },
              )
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            })
          })
        let replaced = false
        const refresh = vi
          .spyOn(api, 'apiPostPublic')
          .mockImplementation(async (route) => {
            assert.equal(route, '/api/cli/auth/refresh')
            const victim = parent ? selected : path
            await rename(victim, `${victim}.old`)
            await symlink(
              parent ? external : sentinel,
              victim,
              parent
                ? process.platform === 'win32'
                  ? 'junction'
                  : 'dir'
                : 'file',
            )
            replaced = true
            const body = {
              access_token: 'test-token-refreshed',
              token_type: 'Bearer',
              expires_at: '2027-01-01T00:00:00.000Z',
            }
            return { response: new Response(JSON.stringify(body)), body }
          })
        const failure = vi
          .spyOn(output, 'writeFailure')
          .mockImplementation(() => undefined)
        const success = vi
          .spyOn(output, 'writeSuccess')
          .mockImplementation(() => undefined)
        const runner = {
          share: runShare,
          append: runAppend,
          update: runUpdate,
        }[command]
        await runner(
          {
            command,
            positionals: command === 'share' ? [path] : ['abc123def4', path],
            options: {
              baseUrl: 'https://example.test',
              profile: 'example',
              ...(command === 'share'
                ? {
                    home: true,
                    visibility: 'private',
                    grantEmail: ['reader@example.test'],
                  }
                : {}),
            },
          },
          { json: true },
        )
        assert.equal(replaced, true)
        assert.equal(refresh.mock.calls.length, 1)
        assert.equal(preparations.mock.calls.length, 1)
        assert.equal(credential.mock.calls.length, 2)
        assert.equal(uploads.mock.calls.length, 2)
        assert.deepEqual(readIdentities, [
          { dev: selectedIdentity.dev, ino: selectedIdentity.ino },
        ])
        for (const [readPath] of pathReads.mock.calls)
          assert.ok(![path, sentinel].includes(String(readPath)))
        assert.equal(pathStreams.mock.calls.length, 0)
        assert.equal(success.mock.calls.length, 1)
        assert.equal(failure.mock.calls.length, 0)
        assert.doesNotMatch(
          JSON.stringify(success.mock.calls),
          /test-token|external-sentinel/,
        )
      } finally {
        vi.restoreAllMocks()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
  for (const phase of ['enumerated', 'before-open', 'opened'] as const) {
    for (const parent of [false, true]) {
      test(`${command} upload boundary rejects ${parent ? 'parent' : 'leaf'} substitution at ${phase} before reads or authentication`, async (context) => {
        const root = await mkdtemp(join(tmpdir(), 'upload-boundary-command-'))
        const original = boundary.readUploadBoundary
        try {
          const selected = join(root, 'selected')
          const external = join(root, 'external')
          await mkdir(selected)
          await mkdir(external)
          await mkdir(join(selected, '.git'))
          const path = join(selected, 'index.html')
          await writeFile(path, '<p>selected</p>')
          await writeFile(join(external, 'index.html'), 'external-sentinel')
          let reads = 0
          const swap = uploadBoundarySwap({
            phase,
            parent,
            selected,
            external,
            path,
          })
          vi.spyOn(boundary, 'readUploadBoundary').mockImplementation(
            (input, options) =>
              original(input, {
                ...options,
                cwd: selected,
                hooks: {
                  reading: () => {
                    reads++
                  },
                  checkpoint: swap.checkpoint,
                },
              }),
          )
          const credential = vi.spyOn(credentials, 'resolveCredential')
          const request = vi.spyOn(api, 'cliFetch')
          const failure = vi
            .spyOn(output, 'writeFailure')
            .mockImplementation(() => undefined)
          const runner = {
            share: runShare,
            append: runAppend,
            update: runUpdate,
          }[command]
          await runner(
            {
              command,
              positionals:
                command === 'share'
                  ? [selected]
                  : ['abc123def4', command === 'append' ? path : selected],
              options: {
                token: 'test-token',
                ...(command === 'share' ? { project: 'example' } : {}),
              },
            },
            { json: true },
          )
          assert.equal(reads, 0)
          assert.equal(credential.mock.calls.length, 0)
          assert.equal(request.mock.calls.length, 0)
          assert.equal(failure.mock.calls.length, 1)
          if (await swap.assertCompleted())
            context.skip(
              'Windows refused the parent rename while a child handle was open',
            )
          const error = failure.mock.calls[0]![1]
          assert.match(error.message, /selected/)
          assert.match(error.hint, /Copy|link target/)
          assert.doesNotMatch(
            JSON.stringify(error),
            /external-sentinel|test-token/,
          )
        } finally {
          vi.restoreAllMocks()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
  test(`${command} upload boundary rejects links before credentials or requests`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'upload-boundary-runner-'))
    try {
      const selected = join(root, 'selected')
      const external = join(root, 'external')
      await mkdir(selected)
      await mkdir(external)
      await mkdir(join(selected, '.git'))
      await writeFile(join(external, 'index.html'), 'external-sentinel')
      await symlink(
        join(external, 'index.html'),
        join(selected, 'file'),
        'file',
      )
      await symlink(
        join(external, 'absent'),
        join(selected, 'dangling'),
        'file',
      )
      await symlink(
        external,
        join(selected, 'dir'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      let requests = 0
      await withServer(
        (_request, response) => {
          requests++
          response.writeHead(500).end()
        },
        async (baseUrl) => {
          for (const input of [
            'file',
            'dangling',
            'dir',
            'dir/index.html',
            '.',
          ]) {
            const args =
              command === 'share'
                ? [command, input, '--project', 'example']
                : [command, 'abc123def4', input]
            const result = await runAsync(
              [...args, '--base-url', baseUrl, '--json'],
              { ARTIFACTSHARE_TOKEN: '' },
              { cwd: selected },
            )
            const payload = expectFailure(result, {
              command,
              code: 'validation_failed',
            })
            assert.match(payload.error.message, /selected|dir|file|dangling/)
            if (command === 'append' && input === '.') {
              // Append rejects the selected directory before inspecting its links.
              assert.match(
                payload.error.message,
                /path must be a non-empty file/,
              )
              assert.equal(
                payload.error.hint,
                'Select a regular file or directory (append requires a regular file).',
              )
            } else {
              assert.match(payload.error.hint, /Copy|link target/)
            }
            assert.doesNotMatch(
              result.stdout + result.stderr,
              /external-sentinel|test-token/,
            )
          }
        },
      )
      assert.equal(requests, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
