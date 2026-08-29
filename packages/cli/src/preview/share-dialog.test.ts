import assert from 'node:assert/strict'
import { request as httpRequest, createServer } from 'node:http'
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { withServer } from '../test/helpers.js'
import { createShareDialogHandler } from './share-dialog.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
} from './contract.js'

type RawResponse = { status: number; body: string }

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of [
    'ARTIFACTSHARE_TOKEN',
    'ARTIFACTSHARE_BASE_URL',
    'ARTIFACTSHARE_CONFIG_HOME',
    'ARTIFACTSHARE_INSECURE_LOCALHOST',
  ]) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Point config resolution at an empty directory so credentials on the
  // developer machine never leak into these tests.
  process.env.ARTIFACTSHARE_CONFIG_HOME = mkdtempSync(
    join(tmpdir(), 'share-dialog-config-'),
  )
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve(address.port)
    })
  })
}

function rawRequest(
  port: number,
  input: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: input.method ?? 'GET',
        path: input.path ?? '/',
        headers: input.headers ?? {},
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    clientRequest.on('error', reject)
    if (input.body !== undefined) clientRequest.end(input.body)
    else clientRequest.end()
  })
}

function mutationHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
  }
}

async function withDialogServer<T>(
  handlerOptions: Partial<Parameters<typeof createShareDialogHandler>[0]>,
  callback: (port: number) => Promise<T>,
): Promise<T> {
  const handler = createShareDialogHandler({
    filePath: '/tmp/report.html',
    fileName: 'report.html',
    artifactOrigin: 'http://127.0.0.1:4100',
    readFileBytes: () => Buffer.from('<h1>hi</h1>'),
    cliOptions: {},
    ...handlerOptions,
  })
  const server = createServer(handler)
  const port = await listen(server)
  try {
    return await callback(port)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('a request with a non-local Host header is rejected', async () => {
  await withDialogServer({}, async (port) => {
    const response = await rawRequest(port, {
      headers: { host: 'evil.example.com' },
    })
    assert.equal(response.status, 403)
  })
})

test('a mutating POST without the preview header is rejected', async () => {
  await withDialogServer({}, async (port) => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/snapshot',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 403)
  })
})

test('a mutating POST without a JSON content type is rejected', async () => {
  await withDialogServer({}, async (port) => {
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/api/snapshot',
      headers: { [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE },
      body: '{}',
    })
    assert.equal(response.status, 403)
  })
})

test('a snapshot can be created and discarded', async () => {
  await withDialogServer(
    { cliOptions: { token: 'test-token' } },
    async (port) => {
      const created = await rawRequest(port, {
        method: 'POST',
        path: '/api/snapshot',
        headers: mutationHeaders(),
        body: '{}',
      })
      assert.equal(created.status, 200)
      const snapshot = JSON.parse(created.body)
      assert.equal(typeof snapshot.snapshot_id, 'string')
      assert.match(snapshot.hash, /^[0-9a-f]{64}$/)
      assert.ok(!Number.isNaN(Date.parse(snapshot.taken_at)))

      const discarded = await rawRequest(port, {
        method: 'POST',
        path: '/api/snapshot/discard',
        headers: mutationHeaders(),
        body: JSON.stringify({ snapshot_id: snapshot.snapshot_id }),
      })
      assert.equal(discarded.status, 200)

      const shareAfterDiscard = await rawRequest(port, {
        method: 'POST',
        path: '/api/share',
        headers: mutationHeaders(),
        body: JSON.stringify({
          snapshot_id: snapshot.snapshot_id,
          visibility: 'private',
        }),
      })
      assert.equal(shareAfterDiscard.status, 404)
    },
  )
})

test('share uploads the snapshot bytes even after the file changes', async () => {
  let received: { url: string; auth: string; body: string } | null = null
  await withServer(
    (request, response) => {
      let body = ''
      request.setEncoding('latin1')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        received = {
          url: request.url ?? '',
          auth: String(request.headers.authorization ?? ''),
          body,
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'artifact-1',
            shareUrl: 'https://share.example/a/artifact-1',
            versionId: 'version-1',
            artifactKind: 'html_page',
          }),
        )
      })
    },
    async (upstreamUrl) => {
      let contents = 'snapshot version one'
      await withDialogServer(
        {
          cliOptions: { token: 'test-token', baseUrl: upstreamUrl },
          readFileBytes: () => Buffer.from(contents),
        },
        async (port) => {
          const created = await rawRequest(port, {
            method: 'POST',
            path: '/api/snapshot',
            headers: mutationHeaders(),
            body: '{}',
          })
          const snapshot = JSON.parse(created.body)

          // Simulate the file changing while the user authenticates.
          contents = 'changed after snapshot'

          const shared = await rawRequest(port, {
            method: 'POST',
            path: '/api/share',
            headers: mutationHeaders(),
            body: JSON.stringify({
              snapshot_id: snapshot.snapshot_id,
              visibility: 'workspace',
            }),
          })
          assert.equal(shared.status, 200)
          const result = JSON.parse(shared.body)
          assert.equal(result.url, 'https://share.example/a/artifact-1')
          assert.equal(result.id, 'artifact-1')
          assert.equal(result.version_id, 'version-1')

          assert.ok(received)
          assert.equal(received.url, '/api/shareables/uploads')
          assert.equal(received.auth, 'Bearer test-token')
          assert.ok(received.body.includes('snapshot version one'))
          assert.ok(!received.body.includes('changed after snapshot'))
          assert.ok(received.body.includes('filename="report.html"'))
          assert.ok(received.body.includes('workspace'))
        },
      )
    },
  )
})

test('share without a credential starts the device flow', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            device_code: 'device-code-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://share.example/device',
            verification_uri_complete:
              'https://share.example/device?code=ABCD-EFGH',
            expires_in: 600,
            interval: 5,
          }),
        )
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    },
    async (upstreamUrl) => {
      await withDialogServer(
        { cliOptions: { baseUrl: upstreamUrl } },
        async (port) => {
          const created = await rawRequest(port, {
            method: 'POST',
            path: '/api/snapshot',
            headers: mutationHeaders(),
            body: '{}',
          })
          const snapshot = JSON.parse(created.body)
          const shared = await rawRequest(port, {
            method: 'POST',
            path: '/api/share',
            headers: mutationHeaders(),
            body: JSON.stringify({
              snapshot_id: snapshot.snapshot_id,
              visibility: 'private',
            }),
          })
          assert.equal(shared.status, 200)
          const body = JSON.parse(shared.body)
          assert.equal(body.auth_required, true)
          assert.equal(body.verification_uri, 'https://share.example/device')
          assert.equal(
            body.verification_uri_complete,
            'https://share.example/device?code=ABCD-EFGH',
          )
          assert.equal(body.user_code, 'ABCD-EFGH')
          assert.equal(typeof body.auth_id, 'string')

          // The snapshot survives the auth round trip: sharing again with
          // the same snapshot id still finds it (auth flow starts again).
          const again = await rawRequest(port, {
            method: 'POST',
            path: '/api/share',
            headers: mutationHeaders(),
            body: JSON.stringify({
              snapshot_id: snapshot.snapshot_id,
              visibility: 'private',
            }),
          })
          assert.equal(again.status, 200)
          assert.equal(JSON.parse(again.body).auth_required, true)
        },
      )
    },
  )
})

test('the dialog page is served with both locales embedded', async () => {
  await withDialogServer({}, async (port) => {
    const response = await rawRequest(port, { path: '/' })
    assert.equal(response.status, 200)
    assert.ok(response.body.includes('preview.shareDialog.title'))
    assert.ok(response.body.includes('共有する'))
    assert.ok(response.body.includes('Keep previewing'))
    assert.ok(response.body.includes('artifactshare-preview-share'))
  })
})

test('a bot profile is told to ask an admin instead of signing in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'as-share-bot-'))
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      default_profile: 'bot',
      profiles: { bot: { kind: 'bot' } },
    }),
  )
  const previousHome = process.env.ARTIFACTSHARE_CONFIG_HOME
  const previousToken = process.env.ARTIFACTSHARE_TOKEN
  process.env.ARTIFACTSHARE_CONFIG_HOME = home
  delete process.env.ARTIFACTSHARE_TOKEN
  try {
    await withDialogServer({ cliOptions: { profile: 'bot' } }, async (port) => {
      const snapshot = JSON.parse(
        (
          await rawRequest(port, {
            method: 'POST',
            path: '/api/snapshot',
            headers: mutationHeaders(),
            body: '{}',
          })
        ).body,
      ) as { snapshot_id: string }
      const share = await rawRequest(port, {
        method: 'POST',
        path: '/api/share',
        headers: mutationHeaders(),
        body: JSON.stringify({
          snapshot_id: snapshot.snapshot_id,
          visibility: 'private',
        }),
      })
      const body = JSON.parse(share.body) as {
        auth_required?: boolean
        error?: { code?: string }
      }
      // Device login under a bot profile would replace it with a human
      // session and strip its bot marker.
      assert.notEqual(body.auth_required, true)
    })
  } finally {
    if (previousHome === undefined) {
      delete process.env.ARTIFACTSHARE_CONFIG_HOME
    } else {
      process.env.ARTIFACTSHARE_CONFIG_HOME = previousHome
    }
    if (previousToken !== undefined) {
      process.env.ARTIFACTSHARE_TOKEN = previousToken
    }
  }
})
