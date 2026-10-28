import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import {
  expectSuccess,
  pathExists,
  rootBypassesFilePermissions,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'
import { skillAutoUpdateHumanOutput } from './output.js'

let workDir: string
let homeDir: string
let configHome: string

const env = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: 'test-token',
})

const loginEnv = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: '',
  ARTIFACTSHARE_TEST_BROWSER_OPENER: 'success',
})

const codexUserSkillPath = () =>
  join(homeDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const claudeUserSkillPath = () =>
  join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const codexProjectSkillPath = () =>
  join(workDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const cursorProjectRulePath = () =>
  join(workDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')
const cursorUserSkillPath = () =>
  join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-auto-skill-work-'))
  workDir = await realpath(workDir)
  homeDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-auto-skill-home-'))
  configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-cli-auto-skill-config-'),
  )
})

afterEach(async () => {
  await chmod(dirname(codexUserSkillPath()), 0o700).catch(() => undefined)
  await chmod(codexUserSkillPath(), 0o600).catch(() => undefined)
  await rm(workDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
  await rm(configHome, { recursive: true, force: true })
})

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

async function writeShareTarget(): Promise<string> {
  const target = join(workDir, 'report.html')
  await writeFile(target, '<html><body>ok</body></html>')
  return target
}

async function runSuccessfulShare<T>(
  callback: (baseUrl: string) => Promise<T>,
) {
  return withServer((request, response) => {
    if (request.url === '/api/shareables/uploads') {
      request.resume()
      request.on('end', () => {
        writeJson(response, {
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'private',
          shareUrl: 'http://127.0.0.1/a/abc123def4',
        })
      })
      return
    }
    response.statusCode = 404
    response.end()
  }, callback)
}

async function runSuccessfulLogin<T>(
  callback: (baseUrl: string) => Promise<T>,
) {
  return withServer((request, response) => {
    if (request.url === '/api/auth/device/code') {
      writeJson(response, {
        device_code: 'device-code-1',
        user_code: 'ABCD1234',
        verification_uri: 'https://artifactshare.test/device',
        verification_uri_complete:
          'https://artifactshare.test/device?user_code=ABCD1234',
        expires_in: 60,
        interval: 1,
      })
      return
    }
    if (request.url === '/api/auth/device/token') {
      writeJson(response, {
        access_token: 'session-token-1',
        token_type: 'Bearer',
        expires_in: 3600,
      })
      return
    }
    if (request.url === '/api/cli/whoami') {
      writeJson(response, {
        user: { id: 'usr_1', email: 'person@example.com' },
        workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        auth: { kind: 'bearer_or_session' },
      })
      return
    }
    if (request.url === '/api/cli/auth/refresh-credentials') {
      writeJson(response, {
        refresh_token: 'refresh-token-1',
        refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
      })
      return
    }
    response.statusCode = 404
    response.end()
  }, callback)
}

async function installSkill(args: string[]) {
  expectSuccess(
    run(['skills', 'install', ...args, '--json'], env(), { cwd: workDir }),
    'skills install',
  )
}

async function downgrade(path: string): Promise<string> {
  const installed = await readFile(path, 'utf8')
  await rm(join(dirname(path), 'references'), { recursive: true, force: true })
  await rm(join(dirname(path), '.artifactshare-managed.json'), { force: true })
  await writeFile(path, installed.replace(/version: \d+/, 'version: 0'))
  return installed
}

test('share auto-updates outdated managed user skills only', async () => {
  await installSkill(['--tool', 'codex', '--scope', 'user'])
  await installSkill(['--tool', 'claude', '--scope', 'user'])
  await installSkill(['--tool', 'cursor', '--scope', 'user'])
  await installSkill(['--tool', 'codex'])
  await installSkill(['--tool', 'cursor'])
  const codexUserInstalled = await downgrade(codexUserSkillPath())
  const claudeUserInstalled = await downgrade(claudeUserSkillPath())
  const cursorUserInstalled = await downgrade(cursorUserSkillPath())
  await downgrade(codexProjectSkillPath())
  await downgrade(cursorProjectRulePath())
  const target = await writeShareTarget()

  await runSuccessfulShare(async (baseUrl) => {
    const result = await runAsync(
      ['share', target, '--home', '--base-url', baseUrl, '--json'],
      env(),
      { cwd: workDir },
    )
    const payload = expectSuccess(result, 'share')
    const targets = payload.data.skills.auto_update.targets
    assert.deepEqual(
      targets.map((item: any) => [item.tool, item.scope, item.action]),
      [
        ['codex', 'user', 'updated'],
        ['claude', 'user', 'updated'],
        ['cursor', 'user', 'updated'],
      ],
    )
    for (const item of targets) {
      assert.equal(item.installed_version, 0)
      assert.equal(typeof item.bundled_version, 'number')
      assert.equal(typeof item.path, 'string')
      assert.equal(item.path.includes(homeDir), true)
      assert.ok(!('update_command' in item))
    }
  })

  assert.equal(await readFile(codexUserSkillPath(), 'utf8'), codexUserInstalled)
  assert.equal(
    await readFile(claudeUserSkillPath(), 'utf8'),
    claudeUserInstalled,
  )
  assert.equal(
    await readFile(cursorUserSkillPath(), 'utf8'),
    cursorUserInstalled,
  )
  assert.match(await readFile(codexProjectSkillPath(), 'utf8'), /version: 0/)
  assert.match(await readFile(cursorProjectRulePath(), 'utf8'), /version: 0/)
})

test('share does not create missing cursor user skill during auto-update', async () => {
  const target = await writeShareTarget()

  await runSuccessfulShare(async (baseUrl) => {
    const result = await runAsync(
      ['share', target, '--home', '--base-url', baseUrl, '--json'],
      env(),
      { cwd: workDir },
    )
    const payload = expectSuccess(result, 'share')
    assert.ok(!payload.data.skills?.auto_update)
  })

  assert.equal(await pathExists(cursorUserSkillPath()), false)
  assert.equal(await pathExists(cursorProjectRulePath()), false)
})

test('share leaves missing unmanaged and broken user skills out of auto-update output', async () => {
  await mkdir(join(homeDir, '.agents', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(codexUserSkillPath(), 'hand-written skill\n')
  await mkdir(join(homeDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(
    claudeUserSkillPath(),
    '<!-- artifactshare-skill\nversion: x\nmanaged: true\n-->\n',
  )
  const target = await writeShareTarget()

  await runSuccessfulShare(async (baseUrl) => {
    const result = await runAsync(
      ['share', target, '--home', '--base-url', baseUrl, '--json'],
      env(),
      { cwd: workDir },
    )
    const payload = expectSuccess(result, 'share')
    assert.ok(!payload.data.skills?.auto_update)
  })

  assert.equal(
    await readFile(codexUserSkillPath(), 'utf8'),
    'hand-written skill\n',
  )
  assert.match(await readFile(claudeUserSkillPath(), 'utf8'), /version: x/)
  assert.equal(await pathExists(join(workDir, '.cursor')), false)
})

test('share does not downgrade managed user skills newer than the bundled version', async () => {
  await installSkill(['--tool', 'codex', '--scope', 'user'])
  const installed = await readFile(codexUserSkillPath(), 'utf8')
  await writeFile(
    codexUserSkillPath(),
    installed.replace(/version: \d+/, 'version: 999'),
  )
  const target = await writeShareTarget()

  await runSuccessfulShare(async (baseUrl) => {
    const result = await runAsync(
      ['share', target, '--home', '--base-url', baseUrl, '--json'],
      env(),
      { cwd: workDir },
    )
    const payload = expectSuccess(result, 'share')
    assert.ok(!payload.data.skills?.auto_update)
  })

  assert.match(await readFile(codexUserSkillPath(), 'utf8'), /version: 999/)
})

test.skipIf(rootBypassesFilePermissions)(
  'share keeps the primary success when user skill auto-update cannot write',
  async () => {
    await installSkill(['--tool', 'codex', '--scope', 'user'])
    await downgrade(codexUserSkillPath())
    await chmod(dirname(codexUserSkillPath()), 0o500)
    const target = await writeShareTarget()

    await runSuccessfulShare(async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--home', '--base-url', baseUrl, '--json'],
        env(),
        { cwd: workDir },
      )
      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.artifact.id, 'abc123def4')
      assert.deepEqual(
        payload.data.skills.auto_update.targets.map((item: any) => [
          item.tool,
          item.scope,
          item.action,
          item.installed_version,
          item.update_command,
        ]),
        [
          [
            'codex',
            'user',
            'update_recommended',
            0,
            'npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --tool codex --scope user --json',
          ],
        ],
      )
    })

    assert.match(await readFile(codexUserSkillPath(), 'utf8'), /version: 0/)
  },
)

test('auto-update returns undefined when user target discovery throws', async () => {
  vi.resetModules()
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>()
    return {
      ...actual,
      homedir: () => {
        throw new Error('homedir unavailable')
      },
    }
  })
  try {
    const { autoUpdateUserManagedSkills } =
      await import('./command-runners/skills.js')
    assert.equal(await autoUpdateUserManagedSkills(), undefined)
  } finally {
    vi.doUnmock('node:os')
    vi.resetModules()
  }
})

test('login --json reports successful user skill auto-update after the pending event', async () => {
  await installSkill(['--tool', 'codex', '--scope', 'user'])
  await downgrade(codexUserSkillPath())

  await runSuccessfulLogin(async (baseUrl) => {
    const result = await runAsync(
      [
        'login',
        '--profile',
        'client-a',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ],
      loginEnv(),
      { cwd: workDir },
    )
    const newline = result.stderr.indexOf('\n')
    assert.notEqual(newline, -1, 'stderr has a pending event line')
    const event = JSON.parse(result.stderr.slice(0, newline))
    assert.equal(event.status, 'pending')
    assert.equal(result.stderr.slice(newline + 1), '')

    const payload = expectSuccess(result, 'login')
    assert.equal(payload.data.profile, 'client-a')
    assert.deepEqual(
      payload.data.skills.auto_update.targets.map((item: any) => [
        item.tool,
        item.scope,
        item.action,
      ]),
      [['codex', 'user', 'updated']],
    )
  })

  assert.doesNotMatch(
    await readFile(codexUserSkillPath(), 'utf8'),
    /version: 0/,
  )
})

test('login without --json still auto-updates outdated user skills in non-interactive JSON mode', async () => {
  await installSkill(['--tool', 'codex', '--scope', 'user'])
  await downgrade(codexUserSkillPath())

  await runSuccessfulLogin(async (baseUrl) => {
    const result = await runAsync(
      [
        'login',
        '--profile',
        'client-a',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
      ],
      loginEnv(),
      { cwd: workDir },
    )
    const payload = expectSuccess(result, 'login')
    assert.equal(payload.data.profile, 'client-a')
    assert.deepEqual(
      payload.data.skills.auto_update.targets.map((item: any) => [
        item.tool,
        item.scope,
        item.action,
      ]),
      [['codex', 'user', 'updated']],
    )
  })

  assert.doesNotMatch(
    await readFile(codexUserSkillPath(), 'utf8'),
    /version: 0/,
  )
})

test('doctor reports outdated skills without auto-updating them', async () => {
  await installSkill(['--tool', 'codex', '--scope', 'user'])
  await downgrade(codexUserSkillPath())

  const payload = expectSuccess(
    run(['doctor', '--json'], env(), { cwd: workDir }),
    'doctor',
  )
  assert.equal(payload.data.skills.update_available, true)
  assert.equal(
    payload.data.skills.targets.some((target: any) => target.update_available),
    true,
  )
  assert.ok(!payload.data.skills.auto_update)
  assert.match(await readFile(codexUserSkillPath(), 'utf8'), /version: 0/)
})

test('doctor reports cursor project and user skill targets', async () => {
  await installSkill(['--tool', 'cursor'])
  await installSkill(['--tool', 'cursor', '--scope', 'user'])

  const payload = expectSuccess(
    run(['doctor', '--json'], env(), { cwd: workDir }),
    'doctor',
  )
  const cursorProject = payload.data.skills.targets.find(
    (target: any) => target.tool === 'cursor' && target.scope === 'project',
  )
  const cursorUser = payload.data.skills.targets.find(
    (target: any) => target.tool === 'cursor' && target.scope === 'user',
  )
  assert.equal(
    cursorProject.path,
    join('.cursor', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(cursorProject.installed, true)
  assert.equal(cursorProject.managed, true)
  assert.equal(cursorUser.path, cursorUserSkillPath())
  assert.equal(cursorUser.installed, true)
  assert.equal(cursorUser.managed, true)
}, 15_000)

test('skill auto-update human output reports updated and recommended targets', () => {
  assert.equal(
    skillAutoUpdateHumanOutput({
      skills: {
        auto_update: {
          targets: [
            { tool: 'codex', scope: 'user', action: 'updated' },
            {
              tool: 'claude',
              scope: 'user',
              action: 'update_recommended',
              update_command:
                'npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --tool claude --scope user --json',
            },
          ],
        },
      },
    }),
    [
      'Skill updated: codex:user',
      'Skill update recommended: claude:user (npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --tool claude --scope user --json)',
      '',
    ].join('\n'),
  )
})

for (const value of ['custom', '', ' \t ']) {
  test(`ordinary command updates only available Claude config ${JSON.stringify(value)}`, async () => {
    const content = await readFile(
      join(import.meta.dirname, '../skills/artifactshare/SKILL.md'),
      'utf8',
    )
    const old = content.replace(/version: \d+/, 'version: 0')
    const custom = join(workDir, 'custom/skills/artifactshare/SKILL.md')
    for (const path of [custom, claudeUserSkillPath(), codexUserSkillPath()]) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, old)
    }
    const result = expectSuccess(
      run(
        ['profiles', 'list', '--json'],
        { ...env(), CLAUDE_CONFIG_DIR: value },
        { cwd: workDir },
      ),
    )
    assert.equal(await readFile(codexUserSkillPath(), 'utf8'), content)
    assert.equal(await readFile(custom, 'utf8'), value.trim() ? content : old)
    assert.equal(await readFile(claudeUserSkillPath(), 'utf8'), old)
    const targets = result.data.skills.auto_update.targets
    assert.equal(
      targets.some((t: any) => t.tool === 'claude'),
      Boolean(value.trim()),
    )
    if (value.trim())
      assert.equal(targets.find((t: any) => t.tool === 'claude').path, custom)
  })
}

for (const state of ['newer', 'unmanaged', 'broken']) {
  test(`custom Claude root preserves ${state} files on ordinary commands`, async () => {
    const bundled = await readFile(
      join(import.meta.dirname, '../skills/artifactshare/SKILL.md'),
      'utf8',
    )
    const content =
      state === 'newer'
        ? bundled.replace(/version: \d+/, 'version: 999999')
        : state === 'broken'
          ? bundled.replace(/version: \d+/, 'version: x')
          : 'Custom user instructions\n'
    const root = join(workDir, 'custom')
    const path = join(root, 'skills/artifactshare/SKILL.md')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
    const result = expectSuccess(
      run(
        ['profiles', 'list', '--json'],
        { ...env(), CLAUDE_CONFIG_DIR: root },
        { cwd: workDir },
      ),
    )
    assert.equal(result.data.skills, undefined)
    assert.equal(await readFile(path, 'utf8'), content)
    assert.equal(await pathExists(claudeUserSkillPath()), false)
  })
}

test('human automatic recommendation includes a repair hint without claiming an update', () => {
  const output = skillAutoUpdateHumanOutput({
    skills: {
      auto_update: {
        targets: [
          {
            tool: 'codex',
            scope: 'user',
            action: 'update_recommended',
            hint: 'Replace the internal link, then retry.',
          },
        ],
      },
    },
  })
  assert.match(output, /Skill update recommended: codex:user/)
  assert.match(output, /Replace the internal link, then retry/)
  assert.ok(!output.includes('Skill updated:'))
})
