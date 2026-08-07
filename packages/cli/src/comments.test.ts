import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

const THREAD = {
  id: 'thr1',
  status: 'open',
  resolved_at: null,
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  anchor: { kind: 'artifact', quoted_text: null, state: null },
  messages: [
    {
      message_id: 'msg1',
      author_name: 'Coji',
      author_email: 'coji@example.com',
      agent: null,
      body: 'First comment',
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
    },
  ],
}

test('comments list --json fails with auth_required before network checks', () => {
  const result = run(['comments', 'list', 'abc123def4', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, { command: 'comments list', code: 'auth_required' })
})

test('comments list --json requires an artifact target', () => {
  const result = run(['comments', 'list', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, {
    command: 'comments list',
    code: 'validation_failed',
  })
})

test('comments list --json rejects an unresolvable target without network', () => {
  const result = run(
    ['comments', 'list', 'https://example.com/not-a-share-url', '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  )

  expectFailure(result, { command: 'comments list', code: 'target_not_found' })
})

test('comments list --json returns threads with has_more', async () => {
  const requests: Array<{ url: string | undefined; auth: string | undefined }> =
    []

  await withServer(
    (request, response) => {
      requests.push({ url: request.url, auth: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          share_url: 'https://example.com/a/abc123def4',
          comments: [THREAD],
          has_more: false,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['comments', 'list', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'comments list')
      assert.deepEqual(payload.data, {
        artifact_id: 'abc123def4',
        share_url: 'https://example.com/a/abc123def4',
        comments: [THREAD],
        has_more: false,
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/artifacts/abc123def4/comments')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
})

test('comments list --json accepts a share URL target', async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, '/api/cli/artifacts/abc123def4/comments')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ artifact_id: 'abc123def4', comments: [] }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'comments',
          'list',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'comments list')
      assert.deepEqual(payload.data.comments, [])
    },
  )
})

test('comments list --json maps a non-viewable artifact to target_not_found', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'not-found', message: 'Artifact not found.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['comments', 'list', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'comments list',
        code: 'target_not_found',
      })
    },
  )
})

test('comments post --json requires --body', () => {
  const result = run(['comments', 'post', 'abc123def4', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  const payload = expectFailure(result, {
    command: 'comments post',
    code: 'validation_failed',
  })
  assert.match(payload.error.hint, /--body/)
})

test('comments post --json rejects --quote with --reply-to', () => {
  const result = run(
    [
      'comments',
      'post',
      'abc123def4',
      '--body',
      'hello',
      '--quote',
      'text',
      '--reply-to',
      'thr1',
      '--json',
    ],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  )

  const payload = expectFailure(result, {
    command: 'comments post',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /--quote or --reply-to/)
})

test('comments post --json rejects quote context without --quote', () => {
  const result = run(
    [
      'comments',
      'post',
      'abc123def4',
      '--body',
      'hello',
      '--quote-before',
      'lead',
      '--json',
    ],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  )

  const payload = expectFailure(result, {
    command: 'comments post',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /require --quote/)
})

test('comments post --json creates a new thread', async () => {
  const requests: Array<{
    url: string | undefined
    auth: string | undefined
    method: string | undefined
    payload: any
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        auth: request.headers.authorization,
        method: request.method,
        payload: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          share_url: 'https://example.com/a/abc123def4',
          thread_id: 'thr1',
          reply: false,
          thread: THREAD,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'comments',
          'post',
          'abc123def4',
          '--body',
          'First comment',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'comments post')
      assert.deepEqual(payload.data, {
        artifact_id: 'abc123def4',
        share_url: 'https://example.com/a/abc123def4',
        thread_id: 'thr1',
        reply: false,
        thread: THREAD,
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/artifacts/abc123def4/comments')
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.payload, { body: 'First comment' })
})

test('comments post --json sends reply_to and quote options', async () => {
  const payloads: any[] = []

  await withServer(
    async (request, response) => {
      payloads.push(JSON.parse(await collectBody(request)))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          thread_id: 'thr1',
          reply: true,
          thread: THREAD,
        }),
      )
    },
    async (baseUrl) => {
      const reply = await runAsync(
        [
          'comments',
          'post',
          'abc123def4',
          '--body',
          'Done',
          '--reply-to',
          'thr1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const replyPayload = expectSuccess(reply, 'comments post')
      assert.equal(replyPayload.data.reply, true)

      const quoted = await runAsync(
        [
          'comments',
          'post',
          'abc123def4',
          '--body',
          'Fix this',
          '--quote',
          'exact text',
          '--quote-before',
          'lead ',
          '--quote-after',
          ' tail',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      expectSuccess(quoted, 'comments post')
    },
  )

  assert.deepEqual(payloads[0], { body: 'Done', reply_to: 'thr1' })
  assert.deepEqual(payloads[1], {
    body: 'Fix this',
    quote: 'exact text',
    quote_before: 'lead ',
    quote_after: ' tail',
  })
})

test('comments post --json accepts values that start with a dash', async () => {
  const payloads: any[] = []

  await withServer(
    async (request, response) => {
      payloads.push(JSON.parse(await collectBody(request)))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          thread_id: 'thr1',
          reply: false,
          thread: THREAD,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'comments',
          'post',
          'abc123def4',
          '--body',
          '- fix the first bullet',
          '--quote',
          '---',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectSuccess(result, 'comments post')
    },
  )

  assert.deepEqual(payloads[0], {
    body: '- fix the first bullet',
    quote: '---',
  })
})

test('comments post --json still rejects a known flag as a missing value', () => {
  const result = run(['comments', 'post', 'abc123def4', '--body', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, {
    command: 'comments post',
    code: 'validation_failed',
  })
})

test('comments post --json maps comment-specific API failures', async () => {
  const cases = [
    { api: 'thread-resolved', status: 409, code: 'thread_resolved' },
    { api: 'thread-not-found', status: 404, code: 'thread_not_found' },
    { api: 'quote-not-found', status: 400, code: 'quote_not_found' },
    { api: 'quote-unsupported', status: 400, code: 'quote_unsupported' },
  ]

  for (const item of cases) {
    await withServer(
      (_request, response) => {
        response.statusCode = item.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ error: { code: item.api } }))
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'comments',
            'post',
            'abc123def4',
            '--body',
            'hello',
            '--base-url',
            baseUrl,
            '--json',
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )

        expectFailure(result, { command: 'comments post', code: item.code })
      },
    )
  }
})

test('comments edit --json requires message id and body', () => {
  const missingMessage = run(
    ['comments', 'edit', 'abc123def4', '--body', 'Updated', '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  )
  expectFailure(missingMessage, {
    command: 'comments edit',
    code: 'validation_failed',
  })

  const missingBody = run(
    ['comments', 'edit', 'abc123def4', '--message-id', 'msg1', '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  )
  expectFailure(missingBody, {
    command: 'comments edit',
    code: 'validation_failed',
  })
})

test('comments edit --json sends an action payload', async () => {
  const requests: Array<{
    url: string | undefined
    method: string | undefined
    payload: any
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        method: request.method,
        payload: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          share_url: 'https://example.com/a/abc123def4',
          thread_id: 'thr1',
          thread: THREAD,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'comments',
          'edit',
          'abc123def4',
          '--message-id',
          ' msg1 ',
          '--body',
          'Updated',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'comments edit')
      assert.deepEqual(payload.data, {
        artifact_id: 'abc123def4',
        share_url: 'https://example.com/a/abc123def4',
        thread_id: 'thr1',
        thread: THREAD,
      })
    },
  )

  assert.equal(requests[0]?.url, '/api/cli/artifacts/abc123def4/comments')
  assert.equal(requests[0]?.method, 'POST')
  assert.deepEqual(requests[0]?.payload, {
    action: 'edit',
    message_id: 'msg1',
    body: 'Updated',
  })
})

test('comments resolve and reopen --json send action payloads', async () => {
  const payloads: any[] = []

  await withServer(
    async (request, response) => {
      payloads.push(JSON.parse(await collectBody(request)))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          thread_id: 'thr1',
          thread: THREAD,
        }),
      )
    },
    async (baseUrl) => {
      const resolved = await runAsync(
        [
          'comments',
          'resolve',
          'abc123def4',
          '--thread-id',
          ' thr1 ',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      expectSuccess(resolved, 'comments resolve')

      const reopened = await runAsync(
        [
          'comments',
          'reopen',
          'abc123def4',
          '--thread-id',
          ' thr1 ',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      expectSuccess(reopened, 'comments reopen')
    },
  )

  assert.deepEqual(payloads, [
    { action: 'resolve', thread_id: 'thr1' },
    { action: 'reopen', thread_id: 'thr1' },
  ])
})

test('comments delete --json deletes a message or whole thread', async () => {
  const payloads: any[] = []

  await withServer(
    async (request, response) => {
      payloads.push(JSON.parse(await collectBody(request)))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact_id: 'abc123def4',
          thread_id: 'thr1',
          deleted: true,
          thread_deleted: payloads.length === 2,
          ...(payloads.length === 1 ? { thread: THREAD } : {}),
        }),
      )
    },
    async (baseUrl) => {
      const message = await runAsync(
        [
          'comments',
          'delete',
          'abc123def4',
          '--thread-id',
          ' thr1 ',
          '--message-id',
          ' msg1 ',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const messagePayload = expectSuccess(message, 'comments delete')
      assert.equal(messagePayload.data.thread_deleted, false)
      assert.deepEqual(messagePayload.data.thread, THREAD)

      const thread = await runAsync(
        [
          'comments',
          'delete',
          'abc123def4',
          '--thread-id',
          ' thr1 ',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const threadPayload = expectSuccess(thread, 'comments delete')
      assert.equal(threadPayload.data.thread_deleted, true)
    },
  )

  assert.deepEqual(payloads, [
    { action: 'delete', thread_id: 'thr1', message_id: 'msg1' },
    { action: 'delete', thread_id: 'thr1' },
  ])
})

test('comments actions --json map action-specific API failures', async () => {
  const cases = [
    { api: 'message-not-found', status: 404, code: 'message_not_found' },
    { api: 'thread-not-found', status: 404, code: 'thread_not_found' },
    { api: 'forbidden', status: 403, code: 'forbidden' },
    { api: 'invalid-comment', status: 400, code: 'validation_failed' },
  ]

  for (const item of cases) {
    await withServer(
      (_request, response) => {
        response.statusCode = item.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ error: { code: item.api } }))
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'comments',
            'edit',
            'abc123def4',
            '--message-id',
            'msg1',
            '--body',
            'Updated',
            '--base-url',
            baseUrl,
            '--json',
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )

        expectFailure(result, { command: 'comments edit', code: item.code })
      },
    )
  }
})

test('comments actions --json reject empty success responses', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 204
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'comments',
          'resolve',
          'abc123def4',
          '--thread-id',
          'thr1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'comments resolve',
        code: 'service_error',
      })
    },
  )
})
