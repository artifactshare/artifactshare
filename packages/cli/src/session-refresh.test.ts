import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  runAsync,
  withServer,
} from './test/helpers.js'

const PROFILE = 'work'
const EXPIRED_TOKEN = 'expired-session-token'
const FRESH_TOKEN = 'fresh-session-token'
const REFRESH_TOKEN = 'refresh-token-1'
const ROTATED_REFRESH_TOKEN = 'refresh-token-2'
const ROTATED_REFRESH_EXPIRES_AT = '2027-02-01T00:00:00.000Z'
const FRESH_EXPIRES_AT = '2026-08-01T00:00:00.000Z'
const ARTIFACT_ID = 'abc123def4'
const PROJECT_ID = 'prj1'
const FILE_TEXT = 'hello from artifact\n'
const FILE_SHA256 = createHash('sha256').update(FILE_TEXT).digest('base64url')

let workDir: string
let homeDir: string

type RequestSnapshot = {
  method: string | undefined
  url: string | undefined
  auth: string | undefined
  body: string
}

type RefreshCase = {
  name: string
  // JSON payload command when it differs from the case name (mode variants).
  command?: string
  args: (baseUrl: string) => string[]
  setup?: () => Promise<void>
  outputCwd?: () => string
  respond: (
    request: RequestSnapshot,
  ) => { status?: number; body: unknown; contentType?: string } | string
}

const isolation = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_CONFIG_HOME: homeDir,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
})

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-refresh-work-'))
  homeDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-refresh-home-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
})

const withProfileArgs = (baseUrl: string, args: string[]) => [
  ...args,
  '--profile',
  PROFILE,
  '--base-url',
  baseUrl,
  '--json',
]

async function writeExpiredSession(
  baseUrl: string,
  pendingRotationId?: string,
): Promise<void> {
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(homeDir, 'tokens.json'),
    JSON.stringify(
      {
        [`${baseUrl}:${PROFILE}`]: JSON.stringify({
          kind: 'session',
          session_token: EXPIRED_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_at: '2026-01-01T00:00:00.000Z',
          ...(pendingRotationId
            ? { pending_rotation_id: pendingRotationId }
            : {}),
        }),
      },
      null,
      2,
    ),
  )
}

async function writeApiTokenProfile(
  baseUrl: string,
  token = 'api-token-1',
): Promise<void> {
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(homeDir, 'tokens.json'),
    JSON.stringify(
      {
        [`${baseUrl}:${PROFILE}`]: JSON.stringify({
          kind: 'api_token',
          token,
        }),
      },
      null,
      2,
    ),
  )
}

async function readStoredSession(baseUrl: string): Promise<any> {
  const tokens = JSON.parse(
    await readFile(join(homeDir, 'tokens.json'), 'utf8'),
  )
  return JSON.parse(tokens[`${baseUrl}:${PROFILE}`])
}

function jsonResponse(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body }
}

function artifactReadBody() {
  return {
    id: ARTIFACT_ID,
    share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
    version_id: 'ver1',
    format: 'markdown',
    content: '# Report',
    size_bytes: 8,
    truncated: false,
    next_offset: null,
  }
}

function artifactListBody() {
  return {
    artifacts: [
      {
        id: ARTIFACT_ID,
        title: 'Weekly report',
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        visibility: 'private',
        updated_at: '2026-07-01T00:00:00.000Z',
        project_id: PROJECT_ID,
      },
    ],
    limit: 50,
    has_more: false,
    next_cursor: null,
  }
}

function projectListBody() {
  return {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Launch',
        description: null,
        base_visibility: 'workspace',
        file_count: 1,
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    ],
  }
}

function editBody() {
  return {
    artifact: {
      id: ARTIFACT_ID,
      url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
    },
    title: 'Renamed',
    destination: { type: 'home', project_id: null },
    share: { visibility: 'private' },
  }
}

function moveBody() {
  return {
    artifact: {
      id: ARTIFACT_ID,
      url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
    },
    destination: { type: 'project', project_id: PROJECT_ID },
    share: {
      visibility: 'project',
      project_audience_may_change: true,
    },
  }
}

function commentThread() {
  return {
    id: 'thr1',
    status: 'open',
    anchor: null,
    messages: [
      {
        message_id: 'msg1',
        author_name: null,
        author_email: 'person@example.com',
        agent: null,
        body: 'Looks good',
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: null,
      },
    ],
  }
}

const refreshCases: RefreshCase[] = [
  {
    name: 'whoami',
    args: (baseUrl) => withProfileArgs(baseUrl, ['whoami']),
    respond: () =>
      jsonResponse({
        user: { id: 'usr1', email: 'person@example.com' },
        workspace: { id: 'wrk1', hosted_domain: null },
        auth: { ok: true },
      }),
  },
  {
    name: 'doctor',
    args: (baseUrl) => withProfileArgs(baseUrl, ['doctor']),
    respond: () =>
      jsonResponse({
        auth: { ok: true },
        user: { email: 'person@example.com' },
        upload: { ok: true },
      }),
  },
  {
    name: 'resolve',
    args: (baseUrl) => withProfileArgs(baseUrl, ['resolve', 'Weekly']),
    respond: () =>
      jsonResponse({ query: 'Weekly', candidates: [], has_more: false }),
  },
  {
    name: 'artifacts list',
    args: (baseUrl) => withProfileArgs(baseUrl, ['artifacts', 'list']),
    respond: () => jsonResponse(artifactListBody()),
  },
  {
    name: 'artifacts get',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['artifacts', 'get', ARTIFACT_ID]),
    respond: () => jsonResponse(artifactReadBody()),
  },
  {
    name: 'open',
    setup: async () => {
      await mkdir(join(workDir, '.claude'), { recursive: true })
    },
    outputCwd: () => workDir,
    args: (baseUrl) => withProfileArgs(baseUrl, ['open', ARTIFACT_ID]),
    respond: () => jsonResponse(artifactReadBody()),
  },
  {
    name: 'download',
    outputCwd: () => workDir,
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'download',
        ARTIFACT_ID,
        '--output',
        join(workDir, 'downloaded'),
      ]),
    respond: (request) => {
      if (request.url?.endsWith('/file.txt')) return FILE_TEXT
      return jsonResponse({
        id: ARTIFACT_ID,
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        version_id: 'ver1',
        artifact_kind: 'static_site',
        files: [
          {
            path: '/file.txt',
            size_bytes: Buffer.byteLength(FILE_TEXT),
            content_type: 'text/plain',
            sha256: FILE_SHA256,
          },
        ],
        total_size_bytes: Buffer.byteLength(FILE_TEXT),
      })
    },
  },
  {
    name: 'download --project-id',
    command: 'download',
    outputCwd: () => workDir,
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'download',
        '--project-id',
        PROJECT_ID,
        '--output',
        join(workDir, 'project-download'),
      ]),
    respond: () =>
      jsonResponse({
        artifacts: [],
        limit: 50,
        has_more: false,
        next_cursor: null,
      }),
  },
  {
    name: 'share',
    setup: async () => {
      await writeFile(join(workDir, 'report.md'), '# Report\n')
    },
    outputCwd: () => workDir,
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['share', 'report.md', '--home']),
    respond: () =>
      jsonResponse({
        id: ARTIFACT_ID,
        shareUrl: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        artifactKind: 'markdown_page',
        versionId: 'ver1',
      }),
  },
  {
    name: 'update',
    setup: async () => {
      await writeFile(join(workDir, 'report.md'), '# Report\n')
    },
    outputCwd: () => workDir,
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['update', ARTIFACT_ID, 'report.md']),
    respond: () =>
      jsonResponse({
        id: ARTIFACT_ID,
        shareUrl: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        artifactKind: 'markdown_page',
        versionId: 'ver2',
      }),
  },
  {
    name: 'append',
    setup: async () => {
      await writeFile(join(workDir, 'section.md'), '## Results\n')
    },
    outputCwd: () => workDir,
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['append', ARTIFACT_ID, 'section.md']),
    respond: () =>
      jsonResponse({
        id: ARTIFACT_ID,
        shareUrl: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        artifactKind: 'markdown_page',
        versionId: 'ver2',
      }),
  },
  {
    name: 'edit',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['edit', ARTIFACT_ID, '--title', 'Renamed']),
    respond: () => jsonResponse(editBody()),
  },
  {
    name: 'move',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'move',
        ARTIFACT_ID,
        '--project-id',
        PROJECT_ID,
      ]),
    respond: () => jsonResponse(moveBody()),
  },
  {
    name: 'delete',
    args: (baseUrl) => withProfileArgs(baseUrl, ['delete', ARTIFACT_ID]),
    respond: () => jsonResponse({ id: ARTIFACT_ID, deleted: true }),
  },
  {
    name: 'projects list',
    args: (baseUrl) => withProfileArgs(baseUrl, ['projects', 'list']),
    respond: () => jsonResponse(projectListBody()),
  },
  {
    name: 'projects create',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['projects', 'create', 'Launch']),
    respond: () =>
      jsonResponse({
        project: {
          id: PROJECT_ID,
          name: 'Launch',
          description: null,
          base_visibility: 'workspace',
        },
      }),
  },
  {
    name: 'projects edit',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'projects',
        'edit',
        PROJECT_ID,
        '--name',
        'Launch v2',
      ]),
    respond: () =>
      jsonResponse({
        project: {
          id: PROJECT_ID,
          name: 'Launch v2',
          description: null,
          base_visibility: 'workspace',
          file_count: 1,
          archived: false,
        },
        audience: [],
      }),
  },
  {
    name: 'comments list',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, ['comments', 'list', ARTIFACT_ID]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        comments: [commentThread()],
        has_more: false,
      }),
  },
  {
    name: 'comments post',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'comments',
        'post',
        ARTIFACT_ID,
        '--body',
        'Looks good',
      ]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        thread_id: 'thr1',
        reply: false,
        thread: commentThread(),
      }),
  },
  {
    name: 'comments edit',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'comments',
        'edit',
        ARTIFACT_ID,
        '--message-id',
        'msg1',
        '--body',
        'Updated',
      ]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        thread_id: 'thr1',
        thread: commentThread(),
      }),
  },
  {
    name: 'comments resolve',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'comments',
        'resolve',
        ARTIFACT_ID,
        '--thread-id',
        'thr1',
      ]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        thread_id: 'thr1',
        thread: { ...commentThread(), status: 'resolved' },
      }),
  },
  {
    name: 'comments reopen',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'comments',
        'reopen',
        ARTIFACT_ID,
        '--thread-id',
        'thr1',
      ]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        thread_id: 'thr1',
        thread: commentThread(),
      }),
  },
  {
    name: 'comments delete',
    args: (baseUrl) =>
      withProfileArgs(baseUrl, [
        'comments',
        'delete',
        ARTIFACT_ID,
        '--thread-id',
        'thr1',
      ]),
    respond: () =>
      jsonResponse({
        share_url: `https://artifactshare.test/a/${ARTIFACT_ID}`,
        thread_id: 'thr1',
        deleted: true,
        thread_deleted: true,
      }),
  },
]

for (const item of refreshCases) {
  test(`${item.name} refreshes an expired session profile once`, async () => {
    await item.setup?.()
    const requests: RequestSnapshot[] = []

    await withServer(
      async (request, response) => {
        const snapshot = {
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          body: await collectBody(request),
        }
        requests.push(snapshot)
        response.setHeader('content-type', 'application/json')

        if (request.url === '/api/cli/auth/refresh') {
          assert.equal(snapshot.auth, undefined)
          const refreshBody = JSON.parse(snapshot.body)
          assert.equal(refreshBody.refresh_token, REFRESH_TOKEN)
          assert.equal(typeof refreshBody.rotation_request_id, 'string')
          assert.ok(refreshBody.rotation_request_id)
          response.end(
            JSON.stringify({
              access_token: FRESH_TOKEN,
              token_type: 'Bearer',
              expires_at: FRESH_EXPIRES_AT,
              refresh_token: ROTATED_REFRESH_TOKEN,
              refresh_token_expires_at: ROTATED_REFRESH_EXPIRES_AT,
            }),
          )
          return
        }

        if (snapshot.auth === `Bearer ${EXPIRED_TOKEN}`) {
          response.statusCode = 401
          response.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        assert.equal(snapshot.auth, `Bearer ${FRESH_TOKEN}`)
        const result = item.respond(snapshot)
        if (typeof result === 'string') {
          response.setHeader('content-type', 'text/plain')
          response.end(result)
          return
        }
        response.statusCode = result.status ?? 200
        response.setHeader(
          'content-type',
          result.contentType ?? 'application/json',
        )
        response.end(JSON.stringify(result.body))
      },
      async (baseUrl) => {
        await writeExpiredSession(baseUrl)
        const result = await runAsync(item.args(baseUrl), isolation(), {
          cwd: item.outputCwd?.() ?? workDir,
        })
        if (result.status !== 0) {
          assert.fail(
            `${item.name} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          )
        }

        const payload = expectSuccess(result, item.command ?? item.name)
        if (item.name === 'whoami') {
          assert.equal(payload.data.session_expires_at, FRESH_EXPIRES_AT)
          assert.equal(
            payload.data.refresh_credential_expires_at,
            ROTATED_REFRESH_EXPIRES_AT,
          )
          assert.equal(payload.data.renewal.kind, 'automatic')
        }
        const stored = await readStoredSession(baseUrl)
        assert.equal(stored.session_token, FRESH_TOKEN)
        assert.equal(stored.refresh_token, ROTATED_REFRESH_TOKEN)
        assert.equal(stored.expires_at, FRESH_EXPIRES_AT)
        assert.equal(
          stored.refresh_credential_expires_at,
          ROTATED_REFRESH_EXPIRES_AT,
        )
      },
    )

    assert.equal(
      requests.filter((request) => request.url === '/api/cli/auth/refresh')
        .length,
      1,
    )
    assert.ok(
      requests.some((request) => request.auth === `Bearer ${EXPIRED_TOKEN}`),
    )
    assert.ok(
      requests.some((request) => request.auth === `Bearer ${FRESH_TOKEN}`),
    )
  })
}

test('whoami stops after one refresh when the retried request is still unauthorized', async () => {
  const requests: RequestSnapshot[] = []

  await withServer(
    async (request, response) => {
      const snapshot = {
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body: await collectBody(request),
      }
      requests.push(snapshot)
      response.setHeader('content-type', 'application/json')

      if (request.url === '/api/cli/auth/refresh') {
        response.end(
          JSON.stringify({
            access_token: FRESH_TOKEN,
            token_type: 'Bearer',
            expires_at: FRESH_EXPIRES_AT,
            refresh_token: ROTATED_REFRESH_TOKEN,
            refresh_token_expires_at: ROTATED_REFRESH_EXPIRES_AT,
          }),
        )
        return
      }

      response.statusCode = 401
      response.end(JSON.stringify({ error: 'unauthorized' }))
    },
    async (baseUrl) => {
      await writeExpiredSession(baseUrl)
      const result = await runAsync(
        withProfileArgs(baseUrl, ['whoami']),
        isolation(),
      )

      expectFailure(result, { command: 'whoami', code: 'auth_required' })
    },
  )

  assert.equal(
    requests.filter((request) => request.url === '/api/cli/auth/refresh')
      .length,
    1,
  )
  assert.equal(
    requests.filter((request) => request.auth === `Bearer ${FRESH_TOKEN}`)
      .length,
    1,
  )
})

test('whoami keeps the original auth_required error when session refresh fails', async () => {
  const requests: RequestSnapshot[] = []

  await withServer(
    async (request, response) => {
      const snapshot = {
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body: await collectBody(request),
      }
      requests.push(snapshot)
      response.setHeader('content-type', 'application/json')

      if (request.url === '/api/cli/auth/refresh') {
        response.destroy()
        return
      }

      response.statusCode = 401
      response.end(JSON.stringify({ error: 'unauthorized' }))
    },
    async (baseUrl) => {
      await writeExpiredSession(baseUrl)
      const result = await runAsync(
        withProfileArgs(baseUrl, ['whoami']),
        isolation(),
      )

      expectFailure(result, { command: 'whoami', code: 'auth_required' })
    },
  )

  assert.equal(
    requests.filter((request) => request.url === '/api/cli/auth/refresh')
      .length,
    1,
  )
})

test('whoami resumes a staged rotation after a prior credential-save failure', async () => {
  const pendingRotationId = 'persisted-rotation-request'
  await withServer(
    async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/cli/auth/refresh') {
        expect(JSON.parse(await collectBody(request))).toEqual({
          refresh_token: REFRESH_TOKEN,
          rotation_request_id: pendingRotationId,
        })
        response.end(
          JSON.stringify({
            access_token: FRESH_TOKEN,
            token_type: 'Bearer',
            expires_at: FRESH_EXPIRES_AT,
            refresh_token: ROTATED_REFRESH_TOKEN,
            refresh_token_expires_at: ROTATED_REFRESH_EXPIRES_AT,
          }),
        )
        return
      }
      if (request.headers.authorization === `Bearer ${EXPIRED_TOKEN}`) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      response.end(
        JSON.stringify({
          user: { id: 'u1', email: 'user@example.com' },
          workspace: { id: 'w1', name: 'Workspace' },
        }),
      )
    },
    async (baseUrl) => {
      await writeExpiredSession(baseUrl, pendingRotationId)
      const result = await runAsync(
        withProfileArgs(baseUrl, ['whoami']),
        isolation(),
      )
      expectSuccess(result, 'whoami')
      const stored = await readStoredSession(baseUrl)
      assert.equal(stored.refresh_token, ROTATED_REFRESH_TOKEN)
      assert.equal(stored.pending_rotation_id, undefined)
    },
  )
})

test('whoami does not refresh an api token profile', async () => {
  const requests: RequestSnapshot[] = []

  await withServer(
    async (request, response) => {
      const snapshot = {
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body: await collectBody(request),
      }
      requests.push(snapshot)
      response.setHeader('content-type', 'application/json')
      response.statusCode = 401
      response.end(JSON.stringify({ error: 'unauthorized' }))
    },
    async (baseUrl) => {
      await writeApiTokenProfile(baseUrl)
      const result = await runAsync(
        withProfileArgs(baseUrl, ['whoami']),
        isolation(),
      )

      expectFailure(result, { command: 'whoami', code: 'token_invalid' })
    },
  )

  assert.equal(
    requests.filter((request) => request.url === '/api/cli/auth/refresh')
      .length,
    0,
  )
  assert.ok(requests.some((request) => request.auth === 'Bearer api-token-1'))
})

test('doctor keeps login recovery visible when session refresh has a network failure', async () => {
  await withServer(
    async (request, response) => {
      response.setHeader('content-type', 'application/json')

      if (request.url === '/api/cli/auth/refresh') {
        response.destroy()
        return
      }

      response.statusCode = 401
      response.end(JSON.stringify({ error: 'unauthorized' }))
    },
    async (baseUrl) => {
      await writeExpiredSession(baseUrl)
      const result = await runAsync(
        withProfileArgs(baseUrl, ['doctor']),
        isolation(),
      )
      const payload = expectSuccess(result, 'doctor')

      assert.equal(payload.data.network.ok, false)
      assert.equal(payload.data.network.code, 'network_failed')
      assert.equal(payload.data.auth.code, 'auth_required')
      assert.match(payload.data.next_command, / login --profile work/)
    },
  )
})
