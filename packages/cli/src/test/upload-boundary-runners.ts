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
import { expectFailure, runAsync, withServer } from './helpers.js'
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
  for (const unsupportedWindows of [false, true]) {
    test(`${command} upload boundary rejects ${unsupportedWindows ? 'unavailable Windows reparse detection' : 'a linked fallback root'} before reads or authentication`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'upload-boundary-root-'))
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
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
        const original = boundary.readUploadBoundary
        vi.spyOn(boundary, 'readUploadBoundary').mockImplementation(
          (input, options) => original(input, { ...options, cwd: root }),
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
        const request = vi.spyOn(api, 'cliFetch')
        const failure = vi
          .spyOn(output, 'writeFailure')
          .mockImplementation(() => undefined)
        if (unsupportedWindows)
          Object.defineProperty(process, 'platform', { value: 'win32' })
        const input = join(unsupportedWindows ? selected : alias, 'index.html')
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
            ![input, join(selected, 'index.html')].includes(String(readPath)),
          )
        assert.equal(pathStreams.mock.calls.length, 0)
        assert.equal(credential.mock.calls.length, 0)
        assert.equal(request.mock.calls.length, 0)
        assert.equal(failure.mock.calls.length, 1)
        const error = failure.mock.calls[0]![1]
        assert.match(
          error.message,
          unsupportedWindows
            ? /reparse-point detection guarantee unavailable/
            : /symbolic link|junction/,
        )
        assert.ok(error.message.includes(unsupportedWindows ? selected : alias))
        assert.match(error.hint, /Copy|link target/)
        assert.doesNotMatch(JSON.stringify(error), /test-token|<p>/)
      } finally {
        Object.defineProperty(process, 'platform', platform)
        vi.restoreAllMocks()
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
        if (process.platform === 'win32') {
          assert.equal(replaced, false)
          assert.equal(refresh.mock.calls.length, 0)
          assert.equal(credential.mock.calls.length, 0)
          assert.equal(uploads.mock.calls.length, 0)
          assert.deepEqual(readIdentities, [])
          assert.equal(success.mock.calls.length, 0)
          assert.equal(failure.mock.calls.length, 1)
          assert.match(
            failure.mock.calls[0]![1].message,
            /reparse-point detection guarantee unavailable/,
          )
          return
        }
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
      test(`${command} upload boundary rejects ${parent ? 'parent' : 'leaf'} substitution at ${phase} before reads or authentication`, async () => {
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
          const error = failure.mock.calls[0]![1]
          assert.match(error.message, /selected/)
          assert.match(error.hint, /Copy|link target/)
          assert.doesNotMatch(
            JSON.stringify(error),
            /external-sentinel|test-token/,
          )
          await swap.assertCompleted()
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
            assert.match(payload.error.hint, /Copy|link target/)
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
