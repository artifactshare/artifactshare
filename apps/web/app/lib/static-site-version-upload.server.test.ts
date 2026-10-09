import { beforeEach, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  abort: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleVersionUploadSession: mocks.begin,
}))
import { runStaticSiteVersionUpload } from './static-site-version-upload.server'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.begin.mockResolvedValue({
    kind: 'ok',
    session: {
      fileCount: 0,
      addFile: mocks.add,
      commitVersion: mocks.commit,
      abort: mocks.abort,
    },
  })
  mocks.commit.mockResolvedValue({ kind: 'missing-entrypoint' })
})

function upload(
  options: { baseVersionId?: string; deletePaths?: string[] } = {},
) {
  return runStaticSiteVersionUpload(
    {} as Kysely<DB>,
    new Request('https://artifactshare.test/api/shareables/s1/versions', {
      method: 'POST',
      body: new FormData(),
    }),
    { id: 'u1', email: 'author@example.com', workspaceId: 'ws1', hd: null },
    's1',
    options,
  )
}

test('a base permits zero files and validates the resulting entrypoint at commit', async () => {
  const response = await upload({
    baseVersionId: 'v1',
    deletePaths: ['index.html'],
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { code: 'missing-entrypoint' },
  })
  expect(mocks.commit).toHaveBeenCalledOnce()
})

test('without a base zero files retain the missing-file response', async () => {
  const response = await upload()
  expect(await response.json()).toMatchObject({
    error: { code: 'missing-file' },
  })
  expect(mocks.abort).toHaveBeenCalledOnce()
  expect(mocks.commit).not.toHaveBeenCalled()
})

test.each([
  [{ kind: 'not-found' }, 404, 'not-found'],
  [
    { kind: 'version-conflict', currentVersionId: 'v2' },
    409,
    'version_conflict',
  ],
  [{ kind: 'validation-failed' }, 400, 'validation-failed'],
] as const)(
  'preserves begin failure envelopes for %j',
  async (result, status, code) => {
    mocks.begin.mockResolvedValue(result)
    const response = await upload({ baseVersionId: 'v1' })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(mocks.commit).not.toHaveBeenCalled()
  },
)
