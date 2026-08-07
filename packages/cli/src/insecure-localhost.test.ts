import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { Request } from 'undici'
import {
  collectBodyBuffer,
  expectSuccess,
  runAsync,
  withHttpsServer,
} from './test/helpers.js'

test('--insecure-localhost supports authenticated and multipart HTTPS requests', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'artifactshare-insecure-localhost-'),
  )
  const singleFile = join(root, 'report.html')
  const directory = join(root, 'site')
  const updateFile = join(root, 'notes.md')
  await writeFile(singleFile, '<h1>Report</h1>')
  await mkdir(join(directory, 'assets'), { recursive: true })
  await writeFile(join(directory, 'index.html'), '<h1>Site</h1>')
  await writeFile(
    join(directory, 'assets', 'style.css'),
    'body { color: red; }',
  )
  await writeFile(updateFile, '# Updated')

  const multipartRequests: Array<{
    path: string
    fields: string[]
    files: Array<{ name: string; type: string; text: string }>
  }> = []
  let shareCount = 0

  try {
    await withHttpsServer(
      (request, response) => {
        void (async () => {
          assert.equal(request.headers.authorization, 'Bearer test-token')
          const url = new URL(request.url ?? '/', 'https://127.0.0.1')
          if (url.pathname === '/api/cli/whoami') {
            response.setHeader('content-type', 'application/json')
            response.end(
              JSON.stringify({
                user: { id: 'usr_1', email: 'person@example.com' },
                workspace: { id: 'wrk_1', hosted_domain: null },
              }),
            )
            return
          }

          const rawBody = await collectBodyBuffer(request)
          const parsedRequest = new Request('https://127.0.0.1/upload', {
            method: 'POST',
            headers: { 'content-type': request.headers['content-type'] ?? '' },
            body: rawBody,
          })
          const form = await parsedRequest.formData()
          const fields: string[] = []
          const files: Array<{ name: string; type: string; text: string }> = []
          for (const [name, value] of form) {
            if (typeof value === 'string') {
              fields.push(`${name}=${value}`)
            } else {
              files.push({
                name: value.name,
                type: value.type,
                text: await value.text(),
              })
            }
          }
          multipartRequests.push({ path: url.pathname, fields, files })

          response.setHeader('content-type', 'application/json')
          if (url.pathname === '/api/shareables/uploads') {
            shareCount += 1
            response.end(
              JSON.stringify({
                id: `artifact-${shareCount}`,
                versionId: `version-${shareCount}`,
                shareUrl: `https://127.0.0.1/a/artifact-${shareCount}`,
              }),
            )
            return
          }
          if (url.pathname === '/api/shareables/abc123def4/versions') {
            response.end(
              JSON.stringify({
                id: 'abc123def4',
                versionId: 'version-3',
                shareUrl: 'https://127.0.0.1/a/abc123def4',
              }),
            )
            return
          }
          response.statusCode = 404
          response.end('{}')
        })().catch((error) => {
          response.statusCode = 500
          response.end(String(error))
        })
      },
      async (baseUrl) => {
        const env = {
          ARTIFACTSHARE_TOKEN: 'test-token',
          ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        }
        const common = ['--base-url', baseUrl, '--insecure-localhost', '--json']
        expectSuccess(await runAsync(['whoami', ...common], env), 'whoami')
        expectSuccess(
          await runAsync(['share', singleFile, '--home', ...common], env),
          'share',
        )
        expectSuccess(
          await runAsync(['share', directory, '--home', ...common], env),
          'share',
        )
        expectSuccess(
          await runAsync(['update', 'abc123def4', updateFile, ...common], env),
          'update',
        )
      },
    )

    assert.deepEqual(multipartRequests, [
      {
        path: '/api/shareables/uploads',
        fields: ['visibility=workspace'],
        files: [
          { name: 'report.html', type: 'text/html', text: '<h1>Report</h1>' },
        ],
      },
      {
        path: '/api/shareables/uploads',
        fields: ['visibility=workspace'],
        files: [
          {
            name: 'assets/style.css',
            type: 'text/css',
            text: 'body { color: red; }',
          },
          { name: 'index.html', type: 'text/html', text: '<h1>Site</h1>' },
        ],
      },
      {
        path: '/api/shareables/abc123def4/versions',
        fields: [],
        files: [{ name: 'notes.md', type: 'text/markdown', text: '# Updated' }],
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
