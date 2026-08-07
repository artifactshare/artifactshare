import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('append --help describes exact single-file append', () => {
  const result = run(['append', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /append <OPTIONS> <artifactIdOrUrl> <path>/)
  assert.match(result.stdout, /Non-empty UTF-8 file/)
  assert.match(result.stdout, /Static sites are not supported/)
})

test('append rejects an empty file before authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifactshare-append-empty-'))
  const path = join(dir, 'empty.md')
  await writeFile(path, '')

  const result = await runAsync(['append', 'abc123def4', path, '--json'])

  const payload = expectFailure(result, {
    command: 'append',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /non-empty file/i)
})

test('append sends UTF-8 content and returns the new version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifactshare-append-'))
  const path = join(dir, 'section.md')
  await writeFile(path, '\n## Added')

  await withServer(
    async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      assert.equal(request.url, '/api/cli/artifacts/abc123def4/append')
      assert.deepEqual(JSON.parse(body), { content: '\n## Added' })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          shareUrl: 'https://artifactshare.test/a/abc123def4',
          versionId: 'version2',
          artifactKind: 'markdown_page',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync([
        'append',
        'abc123def4',
        path,
        '--base-url',
        baseUrl,
        '--token',
        'token',
        '--json',
      ])
      const payload = expectSuccess(result, 'append')
      assert.equal(payload.data.version.id, 'version2')
      assert.equal(payload.data.result.appended, true)
    },
  )
})

test('append does not recommend a blind retry after a network failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifactshare-append-network-'))
  const path = join(dir, 'section.md')
  await writeFile(path, 'added')

  const result = await runAsync([
    'append',
    'abc123def4',
    path,
    '--base-url',
    'http://127.0.0.1:1',
    '--token',
    'token',
    '--json',
  ])

  const payload = expectFailure(result, {
    command: 'append',
    code: 'append_outcome_unknown',
  })
  assert.equal(payload.error.recovery?.kind, 'run_command')
  assert.match(payload.error.hint, /artifacts get abc123def4/)
})

test('append maps a proven version conflict to a safe retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifactshare-append-conflict-'))
  const path = join(dir, 'section.md')
  await writeFile(path, 'added')

  await withServer(
    (_request, response) => {
      response.statusCode = 409
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'version_conflict',
            message: 'The artifact changed before append.',
            details: { current_version_id: 'current-v2' },
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync([
        'append',
        'abc123def4',
        path,
        '--base-url',
        baseUrl,
        '--token',
        'token',
        '--json',
      ])
      const payload = expectFailure(result, {
        command: 'append',
        code: 'version_conflict',
      })
      assert.equal(payload.error.details?.current_version_id, 'current-v2')
      assert.equal(payload.error.recovery?.kind, 'retry_later')
    },
  )
})
