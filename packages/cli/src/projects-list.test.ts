import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-work-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

test('projects create --help explains how to persist its visibility default', () => {
  const result = run(['projects', 'create', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /default_project_visibility/)
  assert.match(result.stdout, /config get default_project_visibility --json/)
  assert.match(
    result.stdout,
    /config set default_project_visibility private --scope repository --json/,
  )
})

test('projects list --json fails with auth_required before network checks', () => {
  const result = run(['projects', 'list', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, { command: 'projects list', code: 'auth_required' })
})

test('projects list --json maps projects and marks the working-directory default', async () => {
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.json'),
    JSON.stringify({ default_project_id: 'prj2' }),
  )
  const requests: Array<{
    url: string | undefined
    auth: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({
        url: request.url,
        auth: request.headers.authorization,
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          projects: [
            {
              id: 'prj1',
              name: 'Launch review',
              description: null,
              base_visibility: 'workspace',
              file_count: 3,
              updated_at: '2026-06-09T00:00:00.000Z',
            },
            {
              id: 'prj2',
              name: 'Weekly reports',
              description: 'Internal',
              base_visibility: 'private',
              file_count: 12,
              updated_at: '2026-06-10T00:00:00.000Z',
            },
          ],
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['projects', 'list', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'projects list')
      assert.equal(payload.data.default_project_id, 'prj2')
      assert.deepEqual(payload.data.projects, [
        {
          id: 'prj1',
          name: 'Launch review',
          description: null,
          base_visibility: 'workspace',
          file_count: 3,
          updated_at: '2026-06-09T00:00:00.000Z',
          is_default: false,
        },
        {
          id: 'prj2',
          name: 'Weekly reports',
          description: 'Internal',
          base_visibility: 'private',
          file_count: 12,
          updated_at: '2026-06-10T00:00:00.000Z',
          is_default: true,
        },
      ])
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/projects')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
})

test('projects list --json succeeds with no projects', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ projects: [] }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['projects', 'list', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'projects list')
      assert.deepEqual(payload.data, {
        default_project_id: null,
        projects: [],
      })
    },
  )
})

test('projects list works when a value flag precedes the command', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ projects: [] }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['--base-url', baseUrl, 'projects', 'list', '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectSuccess(result, 'projects list')
    },
  )
})

test('projects list --json maps API auth failures', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'unauthorized' }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['projects', 'list', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'bad-token' },
      )

      expectFailure(result, { command: 'projects list' })
    },
  )
})

test('projects create --json posts project input and returns next command', async () => {
  const requests: Array<{
    url: string | undefined
    method: string | undefined
    auth: string | undefined
    body: unknown
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        method: request.method,
        auth: request.headers.authorization,
        body: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          project: {
            id: 'prj_new',
            name: 'Client reports',
            description: 'Weekly',
            base_visibility: 'private',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'create',
          'Client reports',
          '--description',
          'Weekly',
          '--visibility',
          'private',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'projects create')
      assert.deepEqual(payload.data.project, {
        id: 'prj_new',
        name: 'Client reports',
        description: 'Weekly',
        base_visibility: 'private',
      })
      assert.equal(
        payload.data.next_command,
        'npx --yes @artifactshare/cli share <path> --project-id prj_new --json',
      )
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/projects')
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.body, {
    name: 'Client reports',
    description: 'Weekly',
    base_visibility: 'private',
  })
})

test('projects create rejects invalid visibility before network', async () => {
  const result = run(
    ['projects', 'create', 'Client', '--visibility', 'public', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, {
    command: 'projects create',
    code: 'validation_failed',
  })
})

test('projects create resolves repository visibility before user visibility', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-project-config-'),
  )
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.json'),
    JSON.stringify({ default_project_visibility: 'private' }),
  )
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({ default_project_visibility: 'workspace' }),
  )
  const bodies: unknown[] = []

  await withServer(
    async (request, response) => {
      bodies.push(JSON.parse(await collectBody(request)))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          project: {
            id: 'prj_default',
            name: 'Client reports',
            description: null,
            base_visibility: 'private',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'create',
          'Client reports',
          '--base-url',
          baseUrl,
          '--json',
        ],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
          ARTIFACTSHARE_CONFIG_HOME: configHome,
        },
        { cwd: workDir },
      )
      const payload = expectSuccess(result, 'projects create')
      assert.equal(payload.data.project.base_visibility, 'private')
    },
  )

  assert.deepEqual(bodies, [
    {
      name: 'Client reports',
      description: null,
      base_visibility: 'private',
    },
  ])
})

test('projects create --json maps project-limit-reached without edit options', async () => {
  const apiMessage =
    "You've reached your plan's project limit (5 projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options."

  await withServer(
    (_request, response) => {
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'project-limit-reached', message: apiMessage },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'create',
          'Sixth project',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'projects create',
        code: 'project_limit_reached',
      })
      assert.equal(payload.error.message, apiMessage)
      assert.match(payload.error.hint, /archive/i)
      assert.match(payload.error.hint, /upgrade/i)
      assert.equal(payload.error.requires_human, true)
    },
  )
})

test('projects create --json maps higher plan project-limit-reached', async () => {
  const apiMessage =
    "You've reached your plan's project limit (20 projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options."

  await withServer(
    (_request, response) => {
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'project-limit-reached', message: apiMessage },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'create',
          'Twenty-first project',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'projects create',
        code: 'project_limit_reached',
      })
      assert.equal(payload.error.message, apiMessage)
    },
  )
})

test('projects edit --json posts partial edits and returns project audience', async () => {
  const requests: Array<{
    url: string | undefined
    method: string | undefined
    auth: string | undefined
    body: unknown
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        method: request.method,
        auth: request.headers.authorization,
        body: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          project: {
            id: 'prj1',
            name: 'Launch review',
            description: null,
            base_visibility: 'private',
            file_count: 3,
            archived: false,
          },
          audience: ['viewer@example.com'],
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'edit',
          'prj1',
          '--name',
          'Launch review',
          '--description',
          '',
          '--visibility',
          'private',
          '--add-email',
          'viewer@example.com',
          '--remove-email',
          'old@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'projects edit')
      assert.deepEqual(payload.data, {
        project: {
          id: 'prj1',
          name: 'Launch review',
          description: null,
          base_visibility: 'private',
          file_count: 3,
          archived: false,
        },
        audience: ['viewer@example.com'],
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/projects/prj1')
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.body, {
    name: 'Launch review',
    description: '',
    base_visibility: 'private',
    add_emails: ['viewer@example.com'],
    remove_emails: ['old@example.com'],
  })
})

test('projects edit rejects conflicting archive flags before network', () => {
  const result = run(
    ['projects', 'edit', 'prj1', '--archive', '--unarchive', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, {
    command: 'projects edit',
    code: 'validation_failed',
  })
})

test('projects edit maps archived project failures', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 409
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'project-archived', message: 'Project is archived.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'edit',
          'prj1',
          '--name',
          'Nope',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'projects edit',
        code: 'project_archived',
      })
    },
  )
})

test('projects edit maps missing projects to target_not_found', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'not-found', message: 'Project not found.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'projects',
          'edit',
          'missing',
          '--archive',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'projects edit',
        code: 'target_not_found',
      })
    },
  )
})
