import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  expectFailure,
  expectSuccess,
  pathExists,
  run,
  runAsync,
  sha256Base64Url,
  withServer,
} from './test/helpers.js'

const deviceAuthEnv = {
  ARTIFACTSHARE_TOKEN: '',
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
}

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function mockDeviceCode(response: ServerResponse) {
  writeJson(response, {
    device_code: 'device-code-1',
    user_code: 'ABCD1234',
    verification_uri: 'https://artifactshare.test/device',
    verification_uri_complete:
      'https://artifactshare.test/device?user_code=ABCD1234',
    expires_in: 60,
    interval: 1,
  })
}

test('download --help explains local save before update', () => {
  const result = run(['download', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /download abc123def4/)
  assert.match(result.stdout, /--output <output>/)
  assert.match(result.stdout, /output_exists/)
})

test('download --json fails before network checks when token store is unavailable', () => {
  const result = run(['download', 'abc123def4', '--json'], deviceAuthEnv)

  const payload = expectFailure(result, {
    command: 'download',
    code: 'token_store_unavailable',
  })
  assert.equal(payload.error.details?.user_code, undefined)
})

test('download --json returns pending device auth without saving artifact details', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-download-auth-'),
  )
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'https://artifactshare.com/a/abc123def4',
          '--output',
          'downloaded-artifact',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )

      const payload = expectFailure(result, {
        command: 'download',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(
        payload.error.details?.verification_uri_complete,
        'https://artifactshare.test/device?user_code=ABCD1234',
      )
      assert.match(
        payload.error.details?.retry_hint as string,
        /rerun the same command/,
      )

      const pendingRaw = await readFile(
        join(configHome, 'pending-device-auth.json'),
        'utf8',
      )
      const pending = JSON.parse(pendingRaw)
      assert.equal(pending[`${baseUrl}:default`].device_code, 'device-code-1')
      assert.doesNotMatch(pendingRaw, /abc123def4/)
      assert.doesNotMatch(pendingRaw, /downloaded-artifact/)
      assert.doesNotMatch(pendingRaw, /artifactshare\.com\/a/)
    },
  )
})

test('download --json with expired profile token returns pending device auth', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-download-profile-auth-'),
  )
  let deviceCodeRequests = 0

  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response)
        return
      }
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'Unauthorized' }))
    },
    async (baseUrl) => {
      await writeFile(
        join(configHome, 'tokens.json'),
        `${JSON.stringify({ [`${baseUrl}:expired`]: 'expired-token' })}\n`,
      )

      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'download',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(payload.error.details?.credential_source, 'profile')
      assert.equal(payload.error.details?.profile, 'expired')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('download --json completes after pending device auth approval', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-download-auth-'),
  )
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-download-file-'))
  const output = join(root, 'downloaded')
  const body = '# Report'
  const requests: string[] = []

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
      requests.push(url)
      if (url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      if (url === '/api/auth/device/token') {
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
        })
        return
      }
      if (url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: null },
        })
        return
      }
      if (url === '/api/cli/auth/refresh-credentials') {
        writeJson(response, {
          refresh_token: 'refresh-token-1',
          refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
        })
        return
      }
      if (url === '/api/cli/artifacts/abc123def4/download') {
        writeJson(response, {
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'markdown_page',
          files: [
            {
              path: '/index.md',
              size_bytes: Buffer.byteLength(body),
              content_type: 'text/markdown',
              sha256: sha256Base64Url(body),
            },
          ],
          total_size_bytes: Buffer.byteLength(body),
        })
        return
      }
      if (url === '/api/cli/artifacts/abc123def4/download/index.md') {
        response.setHeader('content-type', 'text/markdown')
        response.end(body)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'download',
        'abc123def4',
        '--output',
        output,
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      expectFailure(await runAsync(args, env), {
        command: 'download',
        code: 'auth_required',
      })
      const completed = await runAsync(args, env)
      const payload = expectSuccess(completed, 'download')
      assert.equal(payload.data.artifact.id, 'abc123def4')
      assert.equal(payload.data.files.count, 1)
    },
  )

  assert.equal(await readFile(join(output, 'index.md'), 'utf8'), body)
  assert.ok(requests.includes('/api/cli/artifacts/abc123def4/download'))
})

test('download rejects ambiguous target input before auth checks', () => {
  const result = run(['download', 'Weekly report', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  const payload = expectFailure(result, {
    command: 'download',
    code: 'target_not_found',
  })
  assert.match(payload.error.why, /Download only accepts/)
  assert.match(payload.error.hint, /resolve/)
})

test('download --json saves manifest files to the output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []
  const indexBody = '<h1>Hello</h1>'
  const appBody = 'console.log(1)'

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      if (request.url === '/api/cli/artifacts/abc123def4/download') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            share_url: 'http://127.0.0.1/a/abc123def4',
            version_id: 'ver123',
            artifact_kind: 'static_site',
            files: [
              {
                path: '/index.html',
                size_bytes: Buffer.byteLength(indexBody),
                content_type: 'text/html',
                sha256: sha256Base64Url(indexBody),
              },
              {
                path: '/assets/app.js',
                size_bytes: Buffer.byteLength(appBody),
                content_type: 'text/javascript',
                sha256: sha256Base64Url(appBody),
              },
            ],
            total_size_bytes:
              Buffer.byteLength(indexBody) + Buffer.byteLength(appBody),
          }),
        )
        return
      }
      if (request.url === '/api/cli/artifacts/abc123def4/download/index.html') {
        response.setHeader('content-type', 'text/html')
        response.end(indexBody)
        return
      }
      if (
        request.url === '/api/cli/artifacts/abc123def4/download/assets/app.js'
      ) {
        response.setHeader('content-type', 'text/javascript')
        response.end(appBody)
        return
      }
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'not-found' } }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'https://artifactshare.com/a/abc123def4',
          '--output',
          output,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'download')
      assert.equal(payload.data.artifact.id, 'abc123def4')
      assert.equal(payload.data.artifact.kind, 'static_site')
      assert.equal(payload.data.version.id, 'ver123')
      assert.equal(payload.data.destination.path, output)
      assert.equal(payload.data.files.count, 2)
      assert.equal(
        payload.data.files.total_size_bytes,
        Buffer.byteLength(indexBody) + Buffer.byteLength(appBody),
      )
    },
  )

  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), indexBody)
  assert.equal(await readFile(join(output, 'assets/app.js'), 'utf8'), appBody)
  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/cli/artifacts/abc123def4/download' },
    {
      method: 'GET',
      url: '/api/cli/artifacts/abc123def4/download/index.html',
    },
    {
      method: 'GET',
      url: '/api/cli/artifacts/abc123def4/download/assets/app.js',
    },
  ])
})

test('download refuses an existing output directory without --force', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')
  await mkdir(output)

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'markdown_page',
          files: [
            {
              path: '/index.md',
              size_bytes: 8,
              content_type: 'text/markdown',
              sha256: '',
            },
          ],
          total_size_bytes: 8,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'download', code: 'output_exists' })
    },
  )
})

test('download rejects an existing output file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')
  await writeFile(output, 'not a directory')

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'markdown_page',
          files: [
            {
              path: '/index.md',
              size_bytes: 8,
              content_type: 'text/markdown',
              sha256: '',
            },
          ],
          total_size_bytes: 8,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'download',
        code: 'validation_failed',
      })
      assert.match(payload.error.message, /not a directory/)
    },
  )
})

test('download rejects empty output values passed as a separate argument', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'markdown_page',
          files: [
            {
              path: '/index.md',
              size_bytes: 8,
              content_type: 'text/markdown',
              sha256: '',
            },
          ],
          total_size_bytes: 8,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          '',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'download',
        code: 'validation_failed',
      })
      assert.match(payload.error.message, /--output/)
    },
  )
})

test('download cleans temporary files when a later file fetch fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')
  const indexBody = '<h1>Hello</h1>'

  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/artifacts/abc123def4/download') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            share_url: 'http://127.0.0.1/a/abc123def4',
            version_id: 'ver123',
            artifact_kind: 'static_site',
            files: [
              {
                path: '/index.html',
                size_bytes: Buffer.byteLength(indexBody),
                content_type: 'text/html',
                sha256: sha256Base64Url(indexBody),
              },
              {
                path: '/assets/missing.js',
                size_bytes: 1,
                content_type: 'text/javascript',
                sha256: 'missing',
              },
            ],
            total_size_bytes: Buffer.byteLength(indexBody) + 1,
          }),
        )
        return
      }
      if (request.url === '/api/cli/artifacts/abc123def4/download/index.html') {
        response.setHeader('content-type', 'text/html')
        response.end(indexBody)
        return
      }
      response.statusCode = 500
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'storage-failed' } }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      assert.equal(result.status, 1)
      assert.equal(await pathExists(output), false)
    },
  )
})

test('download --force replaces stale files instead of merging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')
  await mkdir(output)
  await writeFile(join(output, 'old.js'), 'stale')
  const indexBody = '<h1>Fresh</h1>'

  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/artifacts/abc123def4/download') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            share_url: 'http://127.0.0.1/a/abc123def4',
            version_id: 'ver123',
            artifact_kind: 'static_site',
            files: [
              {
                path: '/index.html',
                size_bytes: Buffer.byteLength(indexBody),
                content_type: 'text/html',
                sha256: sha256Base64Url(indexBody),
              },
            ],
            total_size_bytes: Buffer.byteLength(indexBody),
          }),
        )
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(indexBody)
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      assert.equal(result.status, 0)
      assert.equal(
        await readFile(join(output, 'index.html'), 'utf8'),
        indexBody,
      )
      assert.equal(await pathExists(join(output, 'old.js')), false)
    },
  )
})

test('download rejects symbolic link output paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'target')
  const output = join(root, 'downloaded')
  await mkdir(target)
  await symlink(target, output)

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'markdown_page',
          files: [
            {
              path: '/index.md',
              size_bytes: 8,
              content_type: 'text/markdown',
              sha256: '',
            },
          ],
          total_size_bytes: 8,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'download',
        code: 'validation_failed',
      })
      assert.match(payload.error.message, /symbolic link/)
    },
  )
})

test('download verifies file size and sha256 before reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')

  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/artifacts/abc123def4/download') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            share_url: 'http://127.0.0.1/a/abc123def4',
            version_id: 'ver123',
            artifact_kind: 'markdown_page',
            files: [
              {
                path: '/index.md',
                size_bytes: 8,
                content_type: 'text/markdown',
                sha256: sha256Base64Url('expected'),
              },
            ],
            total_size_bytes: 8,
          }),
        )
        return
      }
      response.setHeader('content-type', 'text/markdown')
      response.end('changed!')
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'download',
        code: 'download_integrity_failed',
      })
      assert.equal(await pathExists(output), false)
    },
  )
})

test('download rejects unsafe manifest paths before writing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const output = join(root, 'downloaded')

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          artifact_kind: 'static_site',
          files: [
            {
              path: '/../escape.txt',
              size_bytes: 4,
              content_type: 'text/plain',
              sha256: 'sha-escape',
            },
          ],
          total_size_bytes: 4,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'download',
          'abc123def4',
          '--output',
          output,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'download',
        code: 'validation_failed',
      })
      assert.match(payload.error.message, /unsafe file path/)
    },
  )
})

// ── project mode ─────────────────────────────────────────────────

type ProjectListEntry = {
  id: string
  title: string
  share_url: string
  visibility: string
  link_expires_at: null
  updated_at: string
  project_id: string
  owner_email: string
  artifact_kind: string
}

function projectEntry(
  id: string,
  artifactKind = 'markdown_page',
): ProjectListEntry {
  return {
    id,
    title: `Title ${id}`,
    share_url: `https://artifactshare.test/a/${id}`,
    visibility: 'workspace',
    link_expires_at: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    project_id: 'proj1',
    owner_email: 'other@example.com',
    artifact_kind: artifactKind,
  }
}

function markdownManifest(id: string, body: string) {
  return {
    id,
    share_url: `https://artifactshare.test/a/${id}`,
    version_id: `ver-${id}`,
    artifact_kind: 'markdown_page',
    files: [
      {
        path: '/index.md',
        size_bytes: Buffer.byteLength(body),
        content_type: 'text/markdown; charset=utf-8',
        sha256: sha256Base64Url(body),
      },
    ],
    total_size_bytes: Buffer.byteLength(body),
    project_id: 'proj1',
  }
}

type ProjectServerOptions = {
  entries: ProjectListEntry[]
  bodies?: Record<string, string>
  failManifestFor?: string[]
  failListPages?: number[]
  pageSize?: number
}

function projectServerHandler(options: ProjectServerOptions) {
  const bodies = options.bodies ?? {}
  return (
    request: Parameters<Parameters<typeof withServer>[0]>[0],
    response: ServerResponse,
  ) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/cli/artifacts') {
      const pageSize = options.pageSize ?? options.entries.length
      const page = Number(url.searchParams.get('cursor') ?? 0)
      if (options.failListPages?.includes(page)) {
        writeJson(response, { error: { code: 'service-error' } }, 500)
        return
      }
      const start = page * pageSize
      const shown = options.entries.slice(start, start + pageSize)
      const hasMore = start + pageSize < options.entries.length
      writeJson(response, {
        artifacts: shown,
        limit: pageSize,
        has_more: hasMore,
        next_cursor: hasMore ? String(page + 1) : null,
      })
      return
    }
    const manifestMatch = url.pathname.match(
      /^\/api\/cli\/artifacts\/([^/]+)\/download$/,
    )
    if (manifestMatch) {
      const id = manifestMatch[1]!
      if (options.failManifestFor?.includes(id)) {
        writeJson(response, { error: { code: 'service-error' } }, 500)
        return
      }
      writeJson(response, markdownManifest(id, bodies[id] ?? `# ${id}`))
      return
    }
    const fileMatch = url.pathname.match(
      /^\/api\/cli\/artifacts\/([^/]+)\/download\/index\.md$/,
    )
    if (fileMatch) {
      const id = fileMatch[1]!
      response.setHeader('content-type', 'text/markdown')
      response.end(bodies[id] ?? `# ${id}`)
      return
    }
    writeJson(response, { error: { code: 'not-found' } }, 404)
  }
}

async function runProjectDownloadCli(baseUrl: string, output: string) {
  return runAsync(
    [
      'download',
      '--project-id',
      'proj1',
      '--output',
      output,
      '--base-url',
      baseUrl,
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )
}

async function readIndexJson(output: string) {
  return JSON.parse(await readFile(join(output, 'index.json'), 'utf8')) as {
    project_id: string
    artifacts: Array<{
      id: string
      status: string
      path?: string
      reason?: string
      owner_email?: string
    }>
  }
}

test('download --project-id saves every artifact under output/<id> with index.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({
      entries: [projectEntry('artaaaa1'), projectEntry('artbbbb2')],
      bodies: { artaaaa1: '# First doc', artbbbb2: '# Second doc' },
    }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      const payload = expectSuccess(result, 'download')
      assert.equal(payload.data.project_id, 'proj1')
      assert.equal(payload.data.ok, 2)
      assert.equal(payload.data.failed, 0)
    },
  )

  assert.equal(
    await readFile(join(output, 'artaaaa1', 'index.md'), 'utf8'),
    '# First doc',
  )
  assert.equal(
    await readFile(join(output, 'artbbbb2', 'index.md'), 'utf8'),
    '# Second doc',
  )
  const index = await readIndexJson(output)
  assert.equal(index.project_id, 'proj1')
  assert.deepEqual(
    index.artifacts.map((a) => [a.id, a.status]),
    [
      ['artaaaa1', 'ok'],
      ['artbbbb2', 'ok'],
    ],
  )
  assert.equal(index.artifacts[0]?.owner_email, 'other@example.com')
})

test('download --project-id skips spa and workspace_app kinds with exit 0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({
      entries: [
        projectEntry('artspa111', 'spa'),
        projectEntry('artapp222', 'workspace_app'),
      ],
    }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      const payload = expectSuccess(result, 'download')
      assert.equal(payload.data.ok, 0)
      assert.equal(payload.data.skipped, 2)
      assert.equal(payload.data.failed, 0)
    },
  )

  const index = await readIndexJson(output)
  assert.deepEqual(
    index.artifacts.map((a) => [a.status, a.reason]),
    [
      ['skipped', 'unsupported-kind'],
      ['skipped', 'unsupported-kind'],
    ],
  )
})

test('download --project-id continues after one failure and exits 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({
      entries: [projectEntry('artaaaa1'), projectEntry('artbbbb2')],
      failManifestFor: ['artaaaa1'],
    }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.ok, true)
      assert.equal(payload.data.failed, 1)
      assert.deepEqual(
        payload.data.failures.map((f: { id: string }) => f.id),
        ['artaaaa1'],
      )
    },
  )

  assert.equal(await pathExists(join(output, 'artbbbb2', 'index.md')), true)
  const index = await readIndexJson(output)
  assert.deepEqual(
    index.artifacts.map((a) => [a.id, a.status]),
    [
      ['artaaaa1', 'failed'],
      ['artbbbb2', 'ok'],
    ],
  )
})

test('download --project-id treats an existing artifact directory as failed without --force and replaces it with --force', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  await mkdir(join(output, 'artaaaa1'), { recursive: true })
  await writeFile(join(output, 'artaaaa1', 'stale.md'), 'stale')

  await withServer(
    projectServerHandler({
      entries: [projectEntry('artaaaa1')],
      bodies: { artaaaa1: '# Fresh doc' },
    }),
    async (baseUrl) => {
      const withoutForce = await runProjectDownloadCli(baseUrl, output)
      assert.equal(withoutForce.status, 1)
      const payload = JSON.parse(withoutForce.stdout)
      assert.equal(payload.data.failed, 1)
      assert.equal(await pathExists(join(output, 'artaaaa1', 'stale.md')), true)

      const withForce = await runAsync(
        [
          'download',
          '--project-id',
          'proj1',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      expectSuccess(withForce, 'download')
    },
  )

  assert.equal(
    await readFile(join(output, 'artaaaa1', 'index.md'), 'utf8'),
    '# Fresh doc',
  )
  assert.equal(await pathExists(join(output, 'artaaaa1', 'stale.md')), false)
})

test('download validates the exclusive target / project mode arguments', async () => {
  const both = run(
    [
      'download',
      'abc123def4',
      '--project-id',
      'proj1',
      '--output',
      'x',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )
  expectFailure(both, { command: 'download', code: 'validation_failed' })

  const neither = run(['download', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })
  expectFailure(neither, { command: 'download', code: 'validation_failed' })

  const noOutput = run(['download', '--project-id', 'proj1', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })
  expectFailure(noOutput, { command: 'download', code: 'validation_failed' })
})

test('download --project-id records listed entries as failed when a later list page fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  const requests: Array<string | undefined> = []

  await withServer(
    (request, response) => {
      requests.push(request.url)
      projectServerHandler({
        entries: [projectEntry('artaaaa1'), projectEntry('artbbbb2')],
        pageSize: 1,
        failListPages: [1],
      })(request, response)
    },
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.data.failed, 1)
    },
  )

  assert.equal(
    requests.some((url) => url?.includes('/download')),
    false,
  )
  const index = await readIndexJson(output)
  assert.deepEqual(
    index.artifacts.map((a) => [a.id, a.status, a.reason]),
    [['artaaaa1', 'failed', 'list interrupted']],
  )
})

test('download --project-id fails without writing index.json when the first list fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({ entries: [], failListPages: [0] }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stderr)
      assert.equal(payload.ok, false)
    },
  )

  assert.equal(await pathExists(join(output, 'index.json')), false)
})

test('download --project-id succeeds on an empty project with an empty index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(projectServerHandler({ entries: [] }), async (baseUrl) => {
    const result = await runProjectDownloadCli(baseUrl, output)
    const payload = expectSuccess(result, 'download')
    assert.equal(payload.data.ok, 0)
    assert.equal(payload.data.failed, 0)
  })

  const index = await readIndexJson(output)
  assert.deepEqual(index.artifacts, [])
})

test('download --project-id rerun leaves unchanged versions with zero file requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  const requests: Array<string | undefined> = []

  const serve = projectServerHandler({
    entries: [projectEntry('artaaaa1')],
    bodies: { artaaaa1: '# Same doc' },
  })
  await withServer(
    (request, response) => {
      requests.push(request.url)
      serve(request, response)
    },
    async (baseUrl) => {
      expectSuccess(await runProjectDownloadCli(baseUrl, output), 'download')
      const before = requests.length

      const rerun = await runProjectDownloadCli(baseUrl, output)
      const payload = expectSuccess(rerun, 'download')
      assert.equal(payload.data.ok, 0)
      assert.equal(payload.data.unchanged, 1)
      assert.equal(payload.data.failed, 0)

      const rerunRequests = requests.slice(before)
      assert.equal(
        rerunRequests.filter((url) => url?.includes('/download/')).length,
        0,
      )
      assert.equal(
        rerunRequests.filter((url) => url?.endsWith('/download')).length,
        1,
      )
    },
  )

  const index = await readIndexJson(output)
  assert.deepEqual(
    index.artifacts.map((a) => [a.id, a.status]),
    [['artaaaa1', 'unchanged']],
  )
  const entry = index.artifacts[0] as {
    version_id?: string
    path?: string
  }
  assert.equal(entry.version_id, 'ver-artaaaa1')
  assert.equal(entry.path, join(output, 'artaaaa1'))
})

test('download --project-id rerun fails on a changed version without --force and refetches with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({
      entries: [projectEntry('artaaaa1')],
      bodies: { artaaaa1: '# First version' },
    }),
    async (baseUrl) => {
      expectSuccess(await runProjectDownloadCli(baseUrl, output), 'download')
    },
  )
  await writeFile(
    join(output, 'index.json'),
    JSON.stringify({
      project_id: 'proj1',
      artifacts: [
        {
          id: 'artaaaa1',
          version_id: 'ver-old',
          status: 'ok',
          path: join(output, 'artaaaa1'),
        },
      ],
    }),
  )

  await withServer(
    projectServerHandler({
      entries: [projectEntry('artaaaa1')],
      bodies: { artaaaa1: '# Second version' },
    }),
    async (baseUrl) => {
      const withoutForce = await runProjectDownloadCli(baseUrl, output)
      assert.equal(withoutForce.status, 1)
      const payload = JSON.parse(withoutForce.stdout)
      assert.equal(payload.data.failed, 1)

      const withForce = await runAsync(
        [
          'download',
          '--project-id',
          'proj1',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const forced = expectSuccess(withForce, 'download')
      assert.equal(forced.data.ok, 1)
      assert.equal(forced.data.unchanged, 0)
    },
  )

  assert.equal(
    await readFile(join(output, 'artaaaa1', 'index.md'), 'utf8'),
    '# Second version',
  )
})

test('download --project-id treats a corrupt index.json as no previous run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  await mkdir(join(output, 'artaaaa1'), { recursive: true })
  await writeFile(join(output, 'index.json'), 'not json{')

  await withServer(
    projectServerHandler({ entries: [projectEntry('artaaaa1')] }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.data.failed, 1)
      assert.deepEqual(payload.data.failures, [
        { id: 'artaaaa1', reason: 'artifact output already exists' },
      ])
    },
  )
})

test('download --project-id --force re-downloads even when the version matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  const requests: Array<string | undefined> = []

  const serve = projectServerHandler({
    entries: [projectEntry('artaaaa1')],
    bodies: { artaaaa1: '# Same doc' },
  })
  await withServer(
    (request, response) => {
      requests.push(request.url)
      serve(request, response)
    },
    async (baseUrl) => {
      expectSuccess(await runProjectDownloadCli(baseUrl, output), 'download')
      const before = requests.length

      const forced = await runAsync(
        [
          'download',
          '--project-id',
          'proj1',
          '--output',
          output,
          '--force',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const payload = expectSuccess(forced, 'download')
      assert.equal(payload.data.ok, 1)
      assert.equal(payload.data.unchanged, 0)
      assert.ok(
        requests.slice(before).some((url) => url?.includes('/download/')),
      )
    },
  )
})

test('download --project-id ignores a structurally corrupt index instead of its valid prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')

  await withServer(
    projectServerHandler({ entries: [projectEntry('artaaaa1')] }),
    async (baseUrl) => {
      expectSuccess(await runProjectDownloadCli(baseUrl, output), 'download')
      const index = await readIndexJson(output)
      await writeFile(
        join(output, 'index.json'),
        JSON.stringify({
          project_id: 'proj1',
          artifacts: [...index.artifacts, null],
        }),
      )

      const rerun = await runProjectDownloadCli(baseUrl, output)
      assert.equal(rerun.status, 1)
      const payload = JSON.parse(rerun.stdout)
      assert.equal(payload.data.unchanged, 0)
      assert.equal(payload.data.failed, 1)
      assert.deepEqual(payload.data.failures, [
        { id: 'artaaaa1', reason: 'artifact output already exists' },
      ])
    },
  )
})

test('download --project-id does not treat a plain file at the artifact path as unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const output = join(root, 'out')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'artaaaa1'), 'not a directory')
  await writeFile(
    join(output, 'index.json'),
    JSON.stringify({
      project_id: 'proj1',
      artifacts: [
        {
          id: 'artaaaa1',
          version_id: 'ver-artaaaa1',
          status: 'ok',
          path: join(output, 'artaaaa1'),
        },
      ],
    }),
  )

  await withServer(
    projectServerHandler({ entries: [projectEntry('artaaaa1')] }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.data.unchanged, 0)
      assert.equal(payload.data.failed, 1)
    },
  )
})

test('download --project-id rejects a symlinked output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-project-'))
  const real = join(root, 'real')
  const output = join(root, 'out-link')
  await mkdir(real, { recursive: true })
  await symlink(real, output)

  await withServer(
    projectServerHandler({ entries: [projectEntry('artaaaa1')] }),
    async (baseUrl) => {
      const result = await runProjectDownloadCli(baseUrl, output)
      expectFailure(result, { command: 'download', code: 'validation_failed' })
    },
  )

  assert.equal(await pathExists(join(real, 'index.json')), false)
})
