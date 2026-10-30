import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { test, vi } from 'vitest'
import type * as Cli from './cli.js'

// The built module is absent when typecheck runs before build.
const builtCli = new URL('../dist/cli.js', import.meta.url).href
const { runCli } = (await import(builtCli)) as typeof Cli

// Exercise the shipped dispatcher without opening a local listener.
for (const flags of [['--version', ' v1 '], ['--version=v1']]) {
  test(`built CLI selects source with ${flags.join(' ')}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifactshare-readback-'))
    const cwd = process.cwd()
    const dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    let requestedPath = ''
    agent
      .get('https://artifactshare.test')
      .intercept({
        path: (path) => {
          requestedPath = path
          return true
        },
        method: 'GET',
      })
      .reply(200, {
        id: 'abc123def4',
        share_url: 'https://artifactshare.test/a/abc123def4',
        version_id: 'v1',
        format: 'markdown',
        content: 'old',
        size_bytes: 5,
        truncated: false,
        next_offset: null,
        link_expires_at: null,
      })
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const exitCode = process.exitCode
    try {
      process.chdir(directory)
      vi.stubEnv('ARTIFACTSHARE_TOKEN', 'test-token')
      vi.stubEnv('ARTIFACTSHARE_CONFIG_HOME', directory)
      vi.stubEnv('ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE', '1')
      setGlobalDispatcher(agent)
      process.exitCode = undefined
      await runCli([
        'artifacts',
        'get',
        'abc123def4',
        ...flags,
        '--baseUrl',
        'https://artifactshare.test',
        '--offset',
        '2',
        '--include',
        'comments',
        '--json',
      ])
      assert.equal(process.exitCode, undefined, stderr.mock.calls.join(''))
      const result = JSON.parse(
        stdout.mock.calls.map((call) => call[0]).join(''),
      )
      assert.equal(result.ok, true)
      const requested = new URL(requestedPath, 'https://artifactshare.test')
      assert.equal(
        requested.searchParams.get('version_id'),
        'v1',
        requestedPath,
      )
      assert.equal(requested.searchParams.get('offset'), '2')
      assert.equal(requested.searchParams.get('include'), 'comments')
      assert.equal(result.data.version_id, 'v1')
      assert.equal(result.data.content, 'old')
      agent.assertNoPendingInterceptors()
    } finally {
      process.chdir(cwd)
      process.exitCode = exitCode
      vi.unstubAllEnvs()
      stdout.mockRestore()
      stderr.mockRestore()
      setGlobalDispatcher(dispatcher)
      await agent.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
