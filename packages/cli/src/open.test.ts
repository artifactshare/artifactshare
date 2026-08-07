import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  pathExists,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

let workDir: string
let homeDir: string

const isolation = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
})

const claudeSkillPath = () =>
  join(workDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const userClaudeSkillPath = () =>
  join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const userCursorSkillPath = () =>
  join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')
const runSkills = (args: string[]) =>
  run(['skills', ...args, '--json'], isolation(), { cwd: workDir })

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-open-work-'))
  homeDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-open-home-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
})

test('open --help explains the first-run flow', () => {
  const result = run(['open', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /open https:\/\/artifactshare\.com\/a/)
  assert.match(result.stdout, /installs or updates/)
  assert.match(result.stdout, /download next_command/)
  assert.match(result.stdout, /skills install --tool <tool> --force/)
})

test('open installs detected Claude skill and reads a single-file artifact', async () => {
  await mkdir(join(workDir, '.claude'))
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.deepEqual(
        payload.data.skills.targets.map((t: any) => [
          t.tool,
          t.scope,
          t.action,
        ]),
        [['claude', 'user', 'installed']],
      )
      assert.equal(payload.data.open.kind, 'read')
      assert.equal(payload.data.open.artifact.id, 'abc123def4')
      assert.equal(payload.data.open.artifact.content, '# Report')
    },
  )

  assert.ok(await pathExists(userClaudeSkillPath()))
  assert.ok(!(await pathExists(claudeSkillPath())))
  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/cli/artifacts/abc123def4' },
  ])
})

test('open returns a download next_command for multi-file artifacts', async () => {
  await mkdir(join(workDir, '.claude'))

  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'unsupported-kind',
            message: 'This artifact cannot be read as a single source file.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.equal(payload.data.open.kind, 'download_required')
      assert.equal(
        payload.data.open.next_command,
        'npx --yes @artifactshare/cli download abc123def4 --output ./artifact --json',
      )
    },
  )
})

test('open updates outdated managed user skills before reading', async () => {
  await mkdir(join(workDir, '.claude'))
  expectSuccess(
    runSkills(['install', '--tool', 'claude', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userClaudeSkillPath(), 'utf8')
  await writeFile(
    userClaudeSkillPath(),
    installed.replace(/version: \d+/, 'version: 0'),
  )

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.ok(
        payload.data.skills.targets.some(
          (target: any) =>
            target.tool === 'claude' &&
            target.scope === 'user' &&
            target.action === 'updated',
        ),
      )
      assert.equal(await readFile(userClaudeSkillPath(), 'utf8'), installed)
    },
  )
})

test('open installs user scope skill without touching outdated project skill', async () => {
  await mkdir(join(workDir, '.claude'))
  expectSuccess(runSkills(['install', '--tool', 'claude']), 'skills install')
  const installed = await readFile(claudeSkillPath(), 'utf8')
  const outdated = installed.replace(/version: \d+/, 'version: 0')
  await writeFile(claudeSkillPath(), outdated)

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.deepEqual(
        payload.data.skills.targets.map((t: any) => [
          t.tool,
          t.scope,
          t.action,
        ]),
        [['claude', 'user', 'installed']],
      )
      assert.ok(await pathExists(userClaudeSkillPath()))
      assert.equal(await readFile(claudeSkillPath(), 'utf8'), outdated)
    },
  )
})

test('open continues without updating a broken managed user skill', async () => {
  await mkdir(join(workDir, '.claude'))
  expectSuccess(
    runSkills(['install', '--tool', 'claude', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userClaudeSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userClaudeSkillPath(), broken)

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.equal(payload.data.open.kind, 'read')
      assert.ok(
        !payload.data.skills.targets.some(
          (target: any) =>
            target.tool === 'claude' &&
            target.scope === 'user' &&
            target.action === 'updated',
        ),
      )
      assert.equal(await readFile(userClaudeSkillPath(), 'utf8'), broken)
    },
  )
})

test('open continues without updating a broken managed cursor user skill', async () => {
  await mkdir(join(workDir, '.cursor'))
  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCursorSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userCursorSkillPath(), broken)

  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectSuccess(result, 'open')
      assert.equal(payload.data.open.kind, 'read')
      assert.ok(
        !payload.data.skills.targets.some(
          (target: any) =>
            target.tool === 'cursor' &&
            target.scope === 'user' &&
            target.action === 'updated',
        ),
      )
      assert.equal(await readFile(userCursorSkillPath(), 'utf8'), broken)
    },
  )
})

test('open stops before reading when cursor user skill ensure finds a conflict', async () => {
  await mkdir(join(workDir, '.cursor'))
  await mkdir(join(homeDir, '.cursor', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userCursorSkillPath(), 'hand-written skill\n')
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.statusCode = 500
      response.end('should not be called')
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectFailure(result, {
        command: 'open',
        code: 'skill_update_conflict',
      })
      assert.equal(
        payload.error.details.path,
        join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md'),
      )
    },
  )

  assert.deepEqual(requests, [])
})

test('open stops before reading when skill ensure finds a conflict', async () => {
  await mkdir(join(workDir, '.claude'))
  await mkdir(join(homeDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userClaudeSkillPath(), 'hand-written skill\n')
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.statusCode = 500
      response.end('should not be called')
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'open',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: workDir },
      )

      const payload = expectFailure(result, {
        command: 'open',
        code: 'skill_update_conflict',
      })
      assert.equal(
        payload.error.details.path,
        join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md'),
      )
    },
  )

  assert.deepEqual(requests, [])
})

test('open fails with auth_required instead of starting login', () => {
  const result = run(
    ['open', 'https://artifactshare.com/a/abc123def4', '--json'],
    { ...isolation(), ARTIFACTSHARE_TOKEN: '' },
    { cwd: workDir },
  )

  expectFailure(result, { command: 'open', code: 'auth_required' })
})
