import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { writeFailure } from './output.js'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'
import { mapApiError } from './errors.js'

test('edit --json fails with auth_required before network checks', () => {
  const result = run(['edit', 'abc123def4', '--title', 'Renamed', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, { command: 'edit', code: 'auth_required' })
})

test('edit posts title, sharing, grants, and project destination', async () => {
  const requests: Array<{
    url: string | undefined
    auth: string | undefined
    body: unknown
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        auth: request.headers.authorization,
        body: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: {
            id: 'abc123def4',
            url: 'https://artifactshare.test/a/abc123def4',
          },
          title: 'Launch plan',
          destination: { type: 'project', project_id: 'prj1' },
          share: { visibility: 'workspace' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'https://artifactshare.test/a/abc123def4',
          '--title',
          'Launch plan',
          '--visibility',
          'workspace',
          '--grant-email',
          'viewer@example.com',
          '--revoke-email',
          'old@example.com',
          '--project-id',
          'prj1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.deepEqual(payload.data, {
        artifact: {
          id: 'abc123def4',
          url: 'https://artifactshare.test/a/abc123def4',
        },
        title: 'Launch plan',
        destination: { type: 'project', project_id: 'prj1' },
        share: { visibility: 'workspace', link_expires_at: null },
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/shareables/abc123def4/edit')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.body, {
    title: 'Launch plan',
    visibility: 'workspace',
    add_emails: ['viewer@example.com'],
    remove_emails: ['old@example.com'],
    destination: { project_id: 'prj1' },
  })
})

test('edit sends link visibility and unlimited expiry', async () => {
  let body: unknown
  await withServer(
    async (request, response) => {
      body = JSON.parse(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Report',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'link', link_expires_at: null },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--visibility',
          'link',
          '--no-link-expiry',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const payload = expectSuccess(result, 'edit')
      assert.equal(payload.data.share.visibility, 'link')
      assert.equal(payload.data.share.link_expires_at, null)
    },
  )
  assert.deepEqual(body, {
    visibility: 'link',
    link_expires_at: null,
  })
})

test('edit --home posts a home destination', async () => {
  const requests: Array<{ body: unknown }> = []

  await withServer(
    async (request, response) => {
      requests.push({ body: JSON.parse(await collectBody(request)) })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Backlog',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'private' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['edit', 'abc123def4', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.deepEqual(payload.data.destination, {
        type: 'home',
        project_id: null,
      })
      assert.equal(payload.data.share.visibility, 'private')
    },
  )

  assert.deepEqual(requests[0]?.body, { destination: 'home' })
})

test('edit allows an empty title to clear the display title', async () => {
  const requests: Array<{ body: unknown }> = []

  await withServer(
    async (request, response) => {
      requests.push({ body: JSON.parse(await collectBody(request)) })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Derived title',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'private' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['edit', 'abc123def4', '--title', '', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.equal(payload.data.title, 'Derived title')
    },
  )

  assert.deepEqual(requests[0]?.body, { title: '' })
})

test('edit rejects missing changes before auth', () => {
  const result = run(['edit', 'abc123def4', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test('edit rejects conflicting destinations before auth', () => {
  const result = run(
    ['edit', 'abc123def4', '--project-id', 'prj1', '--home', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'edit', code: 'destination_conflict' })
})

test('edit rejects unsupported visibility before auth', () => {
  const result = run(
    ['edit', 'abc123def4', '--visibility', 'unsupported', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test('edit rejects --title without a value before auth', () => {
  const result = run(['edit', 'abc123def4', '--title', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test.each([
  [
    'link-sharing-plan-required',
    402,
    'link_sharing_plan_required',
    'Link sharing is unavailable for this workspace.',
    'Ask a workspace owner or administrator to review the workspace plan or link sharing policy.',
    true,
    false,
    'ask_human',
  ],
  [
    'link-sharing-disabled',
    403,
    'link_sharing_disabled',
    'Link sharing is paused for this workspace; the owner or a Team admin can resume it.',
    'Ask a workspace owner or administrator to review the workspace plan or link sharing policy.',
    true,
    false,
    'ask_human',
  ],
  [
    'link-expiry-invalid',
    400,
    'link_expiry_invalid',
    'The requested link expiry does not match the link sharing policy.',
    'Pass a future RFC3339 UTC timestamp within the workspace maximum, or use --no-link-expiry when unlimited expiry is allowed.',
    false,
    true,
    'change_input',
  ],
  [
    'link-publish-rate-limited',
    429,
    'link_publish_rate_limited',
    'New Free workspaces may publish a bounded number of links per day; the limit protects link sharing from abuse.',
    'Share with specific people now and retry the link visibility after the window passes (about a day), or ask the owner about the workspace plan.',
    false,
    true,
    'retry_later',
  ],
] as const)(
  'maps %s from its API status to the CLI error contract',
  (
    apiCode,
    status,
    code,
    why,
    hint,
    requiresHuman,
    agentRecoverable,
    recoveryKind,
  ) => {
    const mapped = mapApiError(status, {
      error: { code: apiCode, message: 'Link policy error.' },
    })
    assert.equal(mapped.code, code)
    assert.equal(mapped.why, why)
    assert.equal(mapped.hint, hint)
    assert.equal(mapped.requires_human, requiresHuman)
    assert.equal(mapped.agent_recoverable, agentRecoverable)
    assert.deepEqual(mapped.recovery, { kind: recoveryKind })
  },
)

test('keeps unknown 403 responses on the generic forbidden contract', () => {
  const mapped = mapApiError(403, {
    error: { code: 'unrecognized-policy-error', message: 'No access.' },
  })

  assert.equal(mapped.code, 'forbidden')
  assert.equal(mapped.requires_human, true)
})

test('keeps 401 auth recovery ahead of link policy mapping', () => {
  const mapped = mapApiError(
    401,
    { error: { code: 'link-sharing-disabled', message: 'Expired token.' } },
    { authenticated: true },
  )

  assert.equal(mapped.code, 'token_invalid')
})

test('edit emits actionable JSON for a link policy 403 from the API', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'link-sharing-disabled',
            message: 'Link sharing is disabled for this workspace.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--visibility',
          'link',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'edit',
        code: 'link_sharing_disabled',
      })
      assert.equal(
        payload.error.why,
        'Link sharing is paused for this workspace; the owner or a Team admin can resume it.',
      )
      assert.equal(
        payload.error.hint,
        'Ask a workspace owner or administrator to review the workspace plan or link sharing policy.',
      )
      assert.equal(payload.error.agent_recoverable, false)
      assert.equal(payload.error.requires_human, true)
      assert.deepEqual(payload.error.recovery, { kind: 'ask_human' })
    },
  )
})

test('edit maps missing targets to target_not_found', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'not-found', message: 'Shareable not found.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--title',
          'Nope',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'target_not_found' })
    },
  )
})

test('edit maps workspace scope failures to workspace_unavailable', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'workspace-unavailable',
            message: 'Workspace visibility is unavailable.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--visibility',
          'workspace',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'workspace_unavailable' })
    },
  )
})

test('edit maps grant limit failures to too_many_grants', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'too-many-grants',
            message: 'Share with at most 50 email addresses.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--grant-email',
          'new@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'too_many_grants' })
    },
  )
})

test('edit sends retention values and reports deleted versions', async () => {
  const requests: unknown[] = []
  await withServer(
    async (request, response) => {
      const body = JSON.parse(await collectBody(request))
      requests.push(body)
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4' },
          title: 'Report',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'private' },
          retain_versions: body.retain_versions,
          deleted_versions: 4,
        }),
      )
    },
    async (baseUrl) => {
      for (const [option, retain] of [
        ['2', 2],
        ['all', null],
      ] as const) {
        const result = await runAsync(
          [
            'edit',
            'abc123def4',
            '--retain-versions',
            option,
            '--base-url',
            baseUrl,
            '--json',
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )
        const response = expectSuccess(result, 'edit')
        assert.equal(response.data.retain_versions, retain)
        assert.equal(response.data.deleted_versions, 4)
      }
    },
  )
  assert.deepEqual(requests, [
    { retain_versions: 2 },
    { retain_versions: null },
  ])
})

for (const option of ['0', '-1', '1.5', 'invalid', '9007199254740992']) {
  test(`edit rejects invalid retention ${option} before authentication`, () => {
    const result = run(
      ['edit', 'abc123def4', `--retain-versions=${option}`, '--json'],
      { ARTIFACTSHARE_TOKEN: '' },
    )
    expectFailure(result, { command: 'edit', code: 'validation_failed' })
  })
}

test.each([false, true])(
  'edit sends project visibility with explicit placement %s',
  async (move) => {
    let body: unknown
    await withServer(
      async (request, response) => {
        body = JSON.parse(await collectBody(request))
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            artifact: {
              id: 'abc123def4',
              url: 'https://artifactshare.test/a/abc123def4',
            },
            title: 'Report',
            destination: { type: 'project', project_id: 'prj1' },
            share: { visibility: 'project' },
          }),
        )
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'edit',
            'abc123def4',
            '--visibility',
            ' project ',
            ...(move ? ['--project-id', 'prj1'] : []),
            '--base-url',
            baseUrl,
            '--json',
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )
        const payload = expectSuccess(result, 'edit')
        assert.equal(payload.data.share.visibility, 'project')
        assert.deepEqual(payload.data.artifact, {
          id: 'abc123def4',
          url: 'https://artifactshare.test/a/abc123def4',
        })
      },
    )
    assert.deepEqual(body, {
      visibility: 'project',
      ...(move ? { destination: { project_id: 'prj1' } } : {}),
    })
  },
)

test.each([false, true])(
  'edit explains project placement refusal in JSON mode %s',
  async (json) => {
    await withServer(
      async (request, response) => {
        assert.deepEqual(JSON.parse(await collectBody(request)), {
          visibility: 'project',
        })
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            error: {
              code: 'invalid-visibility',
              message:
                'Project visibility requires the artifact to be in a project.',
            },
          }),
        )
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'edit',
            'abc123def4',
            '--visibility',
            'project',
            '--base-url',
            baseUrl,
            ...(json ? ['--json'] : []),
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )
        assert.equal(result.status, 1)
        if (json) {
          const payload = expectFailure(result, {
            command: 'edit',
            code: 'validation_failed',
          })
          assert.match(payload.error.why, /requires project placement/)
          assert.match(payload.error.hint, /edit <id> --project-id <id>/)
          assert.match(payload.error.hint, /move <id> --project-id <id>/)
          assert.deepEqual(payload.error.recovery, { kind: 'change_input' })
          assert.equal(payload.error.agent_recoverable, true)
          assert.equal(payload.error.requires_human, false)
        } else {
          assert.match(result.stderr, /requires.*project/)
          assert.match(result.stderr, /edit <id> --project-id <id>/)
        }
      },
    )
  },
)

test('non-edit invalid visibility retains generic recovery', () => {
  const error = mapApiError(400, { error: { code: 'invalid-visibility' } })
  assert.equal(error.code, 'validation_failed')
  assert.equal(
    error.hint,
    'Check the path, file types, and visibility options, then retry.',
  )
})

test('project placement refusal includes recovery in human output', () => {
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true)
  const previousExitCode = process.exitCode
  try {
    writeFailure(
      'edit',
      mapApiError(
        400,
        { error: { code: 'invalid-visibility' } },
        { editSettings: true },
      ),
      { json: false },
      1,
    )
    assert.equal(process.exitCode, 1)
    const text = stderr.mock.calls.map(([chunk]) => chunk).join('')
    assert.match(
      text,
      /Project visibility requires the artifact to be in a project/,
    )
    assert.match(
      text,
      /Hint: Use edit <id> --project-id <id> --visibility project/,
    )
    assert.match(text, /move <id> --project-id <id>/)
  } finally {
    stderr.mockRestore()
    process.exitCode = previousExitCode
  }
})
