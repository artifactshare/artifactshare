import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi, type TestContext } from 'vitest'
import type { DownloadManifestResponse } from '@artifactshare/contract'
import { prepareDownloadPlan } from './files.js'
import { WriteBoundary, WriteBoundaryError } from './write-boundary.js'

async function fixture(t: TestContext) {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'download-plan-')),
  )
  t.onTestFinished(() => fs.rm(base, { recursive: true, force: true }))
  return { base, output: join(base, 'output') }
}

function manifest(paths: string[]): DownloadManifestResponse {
  return {
    id: 'abc123def4',
    artifact_kind: 'static_site',
    version_id: 'version',
    share_url: 'https://example.test/a/abc123def4',
    total_size_bytes: paths.length,
    files: paths.map((path) => ({
      path,
      size_bytes: 1,
      content_type: 'text/html',
      sha256: '',
    })),
  }
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`manifest case collisions follow ${platform} policy`, async (t) => {
    const { output } = await fixture(t)
    const boundary = new WriteBoundary()
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', {
        value: platform,
      }),
    )
    try {
      const plan = prepareDownloadPlan(
        manifest(['/About.html', '/about.html']),
        output,
        false,
        boundary,
      )
      if (platform === 'linux') assert.ok((await plan).value)
      else await assert.rejects(plan, WriteBoundaryError)
    } finally {
      vi.unstubAllGlobals()
      await boundary.cleanup()
    }
  })
}

for (const paths of [
  ['/a', '/a'],
  ['/a', '/a/b'],
  ['/a/b', '/a'],
  ['/a/b/c', '/a'],
]) {
  test(`manifest conflicts fail before staging: ${paths.join(', ')}`, async (t) => {
    const { base, output } = await fixture(t)
    await assert.rejects(
      prepareDownloadPlan(manifest(paths), output, false),
      WriteBoundaryError,
    )
    assert.deepEqual(await fs.readdir(base), [])
  })
}

test('case folding work grows with manifest entries rather than pairs', async (t) => {
  const { output } = await fixture(t)
  const boundary = new WriteBoundary()
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', {
      value: 'darwin',
    }),
  )
  const lower = vi.spyOn(String.prototype, 'toLowerCase')
  try {
    const paths = Array.from(
      { length: 200 },
      (_, index) => `/assets/page-${index}.html`,
    )
    assert.ok(
      (await prepareDownloadPlan(manifest(paths), output, false, boundary))
        .value,
    )
    assert.ok(lower.mock.calls.length < 1000)
  } finally {
    lower.mockRestore()
    vi.unstubAllGlobals()
    await boundary.cleanup()
  }
})

test('existing output without force returns output_exists without walking its contents', async (t) => {
  const { output } = await fixture(t)
  await fs.mkdir(output)
  await fs.writeFile(join(output, 'existing'), 'keep')
  const visited: string[] = []
  const boundary = new WriteBoundary({
    lstat: async (path) => {
      visited.push(path)
      return fs.lstat(path, { bigint: true })
    },
  })
  const plan = await prepareDownloadPlan(
    manifest(['/index.html']),
    output,
    false,
    boundary,
  )
  assert.equal(plan.error?.code, 'output_exists')
  assert.ok(!visited.includes(join(output, 'existing')))
  assert.equal(await fs.readFile(join(output, 'existing'), 'utf8'), 'keep')
})
