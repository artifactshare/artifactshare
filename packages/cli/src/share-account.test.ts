import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { runShare } from './command-runners/share.js'
import { resolveCredential } from './credentials.js'
import {
  resolveProjectConfig,
  resolveSharedProjectConfig,
} from './destination.js'
import type { CliOptions } from './types.js'
import { collectBody, formField, withServer } from './test/server.js'

vi.mock('./credentials.js', () => ({ resolveCredential: vi.fn() }))
vi.mock('./destination.js', async (original) => ({
  ...(await original<typeof import('./destination.js')>()),
  resolveProjectConfig: vi.fn(),
  resolveSharedProjectConfig: vi.fn(),
}))

let root: string
let target: string
let available: boolean | undefined
/** The visibility field of every upload POST the CLI made, in order. */
let posts: string[]
/** How many capability (whoami) requests the CLI made. */
let reads: number
let rejectWorkspace: boolean
let confirmed: string | undefined
let identityStatus: number
let uploadCreated: boolean | undefined
let bearers: string[]
let stdout: string
let stderr: string

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'artifactshare-account-'))
  target = join(root, 'report.html')
  await writeFile(target, '<h1>Report</h1>')
  vi.stubEnv('ARTIFACTSHARE_CONFIG_HOME', root)
  vi.stubEnv('ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE', '1')
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'profile',
    profile: 'default',
    profileCredentialKind: 'session',
    botProfile: false,
  })
  const empty = {
    config: null,
    raw: null,
    kind: null,
    path: null,
    directory: null,
  }
  vi.mocked(resolveProjectConfig).mockResolvedValue(empty)
  vi.mocked(resolveSharedProjectConfig).mockResolvedValue(empty)
  available = false
  posts = []
  reads = 0
  bearers = []
  rejectWorkspace = false
  confirmed = undefined
  identityStatus = 200
  uploadCreated = undefined
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  await rm(root, { recursive: true, force: true })
})

/** Serve the Artifact Share endpoints `share` uses, recording what it sent. */
async function share(options: CliOptions = {}) {
  await withServer(
    async (request, response) => {
      bearers.push(request.headers.authorization ?? '')
      const path = (request.url ?? '').split('?')[0]
      response.setHeader('content-type', 'application/json')
      if (path === '/api/cli/whoami') {
        reads += 1
        response.statusCode = identityStatus
        return response.end(
          JSON.stringify({
            workspace: {
              hosted_domain: null,
              ...(available === undefined
                ? {}
                : { visibility_available: available }),
            },
          }),
        )
      }
      if (path === '/api/cli/projects')
        return response.end(
          JSON.stringify({ projects: [{ id: 'prj1', name: 'Reports' }] }),
        )
      expect(path).toBe('/api/shareables/uploads')
      expect(request.method).toBe('POST')
      const visibility = String(
        formField(await collectBody(request), 'visibility'),
      )
      posts.push(visibility)
      if (rejectWorkspace && visibility === 'workspace') {
        response.statusCode = 400
        return response.end(
          JSON.stringify({ error: { code: 'workspace-unavailable' } }),
        )
      }
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          shareUrl: 'https://artifactshare.test/a/abc123def4',
          artifactKind: 'html_page',
          visibility: confirmed ?? visibility,
          ...(uploadCreated === undefined ? {} : { created: uploadCreated }),
        }),
      )
    },
    async (baseUrl) => {
      await runShare(
        {
          command: 'share',
          positionals: [target],
          options: { baseUrl, ...options },
        },
        { json: true },
      )
    },
  )
}

const succeeded = () => {
  expect(stderr).toBe('')
  const payload = JSON.parse(stdout)
  expect(payload).toMatchObject({ ok: true, command: 'share' })
  return payload.data as { share: Record<string, unknown> }
}
const failed = () => {
  expect(stdout).toBe('')
  const payload = JSON.parse(stderr)
  expect(payload.ok).toBe(false)
  expect(process.exitCode).toBe(1)
  return payload.error as { code: string }
}

test.each(['html', 'md', 'directory'])(
  'private default for %s makes one content POST and explains why',
  async (kind) => {
    if (kind === 'directory') {
      target = root
      await writeFile(join(root, 'index.html'), '<h1>Site</h1>')
    }
    if (kind === 'md') {
      target = join(root, 'report.md')
      await writeFile(target, '# Report')
    }
    await share()
    expect(posts).toEqual(['private'])
    expect(reads).toBe(1)
    expect(bearers).toEqual(['Bearer test-token', 'Bearer test-token'])
    const { share: result } = succeeded()
    expect(result.visibility).toBe('private')
    expect(result.visibility_source).toBe('product_default_private')
    expect(typeof result.visibility_hint).toBe('string')
    expect(String(result.visibility_hint).length).toBeGreaterThan(0)
  },
)

test.each([true, undefined])(
  'true or missing capability retains workspace (%s)',
  async (capability) => {
    available = capability
    await share()
    expect(posts).toEqual(['workspace'])
    const { share: result } = succeeded()
    expect(result.visibility).toBe('workspace')
    expect(result).not.toHaveProperty('visibility_source')
  },
)

test.each(['private', 'link', 'workspace'])(
  'explicit %s bypasses the default, preserving rejection',
  async (visibility) => {
    rejectWorkspace = true
    await share({ visibility })
    expect(reads).toBe(0)
    expect(posts).toEqual([visibility])
    if (visibility === 'workspace')
      expect(failed().code).toBe('validation_failed')
    else expect(succeeded().share.visibility).toBe(visibility)
  },
)

for (const scope of ['repository', 'user']) {
  test.each(['home_audience', 'default_artifact_visibility'])(
    `configured ${scope} %s remains workspace and rejects once`,
    async (key) => {
      rejectWorkspace = true
      if (scope === 'repository')
        vi.mocked(resolveSharedProjectConfig).mockResolvedValue({
          config: { [key]: 'workspace' },
          raw: { [key]: 'workspace' },
          kind: 'shared',
          path: '.artifactshare/config.json',
          directory: root,
        })
      else
        await writeFile(
          join(root, 'config.json'),
          JSON.stringify({ [key]: 'workspace' }),
        )
      await share()
      expect(reads).toBe(0)
      expect(posts).toEqual(['workspace'])
      expect(failed().code).toBe('validation_failed')
    },
  )
}

test.each([
  { projectId: 'prj1' },
  { project: 'Reports' },
  { projectId: 'prj1', visibility: 'private' },
])('project audience has no capability dependency %j', async (options) => {
  await share(options)
  expect(reads).toBe(0)
  expect(posts).toEqual([options.visibility ?? 'project'])
})

test('repository project stays project; --home applies the account default', async () => {
  vi.mocked(resolveProjectConfig).mockResolvedValue({
    config: { default_project_id: 'prj1' },
    raw: {},
    kind: 'shared',
    path: '.artifactshare/config.json',
    directory: root,
  })
  await share()
  expect(posts).toEqual(['project'])
  expect(reads).toBe(0)
  stdout = ''
  await share({ home: true })
  expect(posts).toEqual(['project', 'private'])
  expect(reads).toBe(1)
})

test('server-confirmed visibility wins and cannot be mislabeled as private fallback', async () => {
  confirmed = 'project'
  await share()
  const { share: result } = succeeded()
  expect(result.visibility).toBe('project')
  expect(result).not.toHaveProperty('visibility_source')
})

test('a failed capability check keeps the workspace product default', async () => {
  identityStatus = 503
  await share()
  expect(posts).toEqual(['workspace'])
})

test('agent/bot profile uses its selected login for capability and upload', async () => {
  vi.mocked(resolveCredential).mockResolvedValue({
    ok: true,
    token: 'test-token',
    source: 'profile',
    profile: 'bot',
    profileCredentialKind: 'session',
    botProfile: true,
  })
  await share()
  expect(reads).toBe(1)
  expect(posts).toEqual(['private'])
})

test('an existing keyed artifact keeps private without a fallback label', async () => {
  uploadCreated = false
  await share({ key: 'job1' })
  expect(posts).toEqual(['private'])
  const { share: result } = succeeded()
  expect(result.visibility).toBe('private')
  expect(result).not.toHaveProperty('visibility_source')
})

test.each([
  { source: 'env' as const },
  {
    source: 'profile' as const,
    profile: 'ci',
    profileCredentialKind: 'api_token' as const,
    botProfile: false,
  },
])(
  'a revoked API token stops with token_invalid before upload (%o)',
  async (credential) => {
    vi.mocked(resolveCredential).mockResolvedValue({
      ok: true,
      token: 'test-token',
      ...credential,
    })
    identityStatus = 401
    await share()
    expect(posts).toEqual([])
    expect(reads).toBe(1)
    expect(failed().code).toBe('token_invalid')
  },
)
