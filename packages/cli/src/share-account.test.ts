import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { Response } from 'undici'
import { runShare } from './command-runners/share.js'
import { cliFetch } from './api.js'
import { resolveCredential } from './credentials.js'
import {
  resolveProjectConfig,
  resolveSharedProjectConfig,
} from './destination.js'
import { writeSuccess, writeFailure } from './output.js'
import type { CliOptions } from './types.js'

vi.mock('./api.js', async (original) => ({
  ...(await original<typeof import('./api.js')>()),
  cliFetch: vi.fn(),
}))
// apiGet closes over the real cliFetch; mock only the transport module used by it.
vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: vi.fn((input: string | URL, init?: import('./types.js').FetchInit) =>
    cliFetch(input, init),
  ),
}))
vi.mock('./credentials.js', () => ({ resolveCredential: vi.fn() }))
vi.mock('./destination.js', async (original) => ({
  ...(await original<typeof import('./destination.js')>()),
  resolveProjectConfig: vi.fn(),
  resolveSharedProjectConfig: vi.fn(),
}))
vi.mock('./output.js', () => ({ writeSuccess: vi.fn(), writeFailure: vi.fn() }))
let root: string
let target: string
let available: boolean | undefined
let posts: string[]
let reads: number
let rejectWorkspace: boolean
let confirmed: string | undefined
let identityStatus: number
let uploadCreated: boolean | undefined

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
  rejectWorkspace = false
  confirmed = undefined
  identityStatus = 200
  uploadCreated = undefined
  vi.mocked(cliFetch).mockImplementation(async (input, init) => {
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    const url = new URL(String(input))
    if (url.pathname === '/api/cli/whoami') {
      reads++
      return new Response(
        JSON.stringify({
          workspace: {
            hosted_domain: null,
            ...(available === undefined
              ? {}
              : { visibility_available: available }),
          },
        }),
        { status: identityStatus },
      )
    }
    if (url.pathname === '/api/cli/projects')
      return new Response(
        JSON.stringify({ projects: [{ id: 'prj1', name: 'Reports' }] }),
      )
    expect(url.pathname).toBe('/api/shareables/uploads')
    expect(init?.method).toBe('POST')
    const form = init?.body as import('undici').FormData
    const visibility = String(form.get('visibility'))
    posts.push(visibility)
    if (rejectWorkspace && visibility === 'workspace')
      return new Response(
        JSON.stringify({ error: { code: 'workspace-unavailable' } }),
        { status: 400 },
      )
    return new Response(
      JSON.stringify({
        id: 'abc123def4',
        versionId: 'v1',
        shareUrl: 'https://artifactshare.test/a/abc123def4',
        artifactKind: 'html_page',
        visibility: confirmed ?? visibility,
        ...(uploadCreated === undefined ? {} : { created: uploadCreated }),
      }),
    )
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function share(options: CliOptions = {}) {
  await runShare(
    {
      command: 'share',
      positionals: [target],
      options: { baseUrl: 'https://artifactshare.test', ...options },
    },
    { json: true },
  )
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
    expect(writeSuccess).toHaveBeenCalledWith(
      'share',
      expect.objectContaining({
        share: expect.objectContaining({
          visibility: 'private',
          visibility_source: 'product_default_private',
          visibility_hint: expect.stringContaining(
            '--visibility link deliberately',
          ),
        }),
      }),
      { json: true },
    )
  },
)

test.each([true, undefined])(
  'true or missing capability retains workspace (%s)',
  async (capability) => {
    available = capability
    await share()
    expect(posts).toEqual(['workspace'])
    expect(vi.mocked(writeSuccess).mock.calls[0]?.[1]).toMatchObject({
      share: { visibility: 'workspace' },
    })
    expect(
      (vi.mocked(writeSuccess).mock.calls[0]![1] as any).share,
    ).not.toHaveProperty('visibility_source')
  },
)

test.each(['private', 'link', 'workspace'])(
  'explicit %s bypasses the default, preserving rejection',
  async (visibility) => {
    rejectWorkspace = true
    await share({ visibility })
    expect(reads).toBe(0)
    expect(posts).toEqual([visibility])
    if (visibility === 'workspace') {
      expect(writeSuccess).not.toHaveBeenCalled()
      expect(writeFailure).toHaveBeenCalledWith(
        'share',
        expect.objectContaining({
          code: 'validation_failed',
          hint: expect.stringContaining('visibility options'),
        }),
        { json: true },
        1,
      )
    } else expect(writeSuccess).toHaveBeenCalledTimes(1)
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
      expect(writeSuccess).not.toHaveBeenCalled()
      expect(writeFailure).toHaveBeenCalledWith(
        'share',
        expect.objectContaining({ code: 'validation_failed' }),
        { json: true },
        1,
      )
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
  await share({ home: true })
  expect(posts).toEqual(['project', 'private'])
  expect(reads).toBe(1)
})

test('server-confirmed visibility wins and cannot be mislabeled as private fallback', async () => {
  confirmed = 'project'
  await share()
  const data = vi.mocked(writeSuccess).mock.calls[0]![1] as any
  expect(data.share.visibility).toBe('project')
  expect(data.share).not.toHaveProperty('visibility_source')
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
  const data = vi.mocked(writeSuccess).mock.calls[0]![1] as {
    share: Record<string, unknown>
  }
  expect(data.share.visibility).toBe('private')
  expect(data.share).not.toHaveProperty('visibility_source')
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
    expect(
      vi.mocked(writeFailure).mock.calls.map(([, error]) => error.code),
    ).toEqual(['token_invalid'])
  },
)
