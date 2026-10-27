import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  pathExists,
  run,
} from './test/helpers.js'

let workDir: string
let configHome: string
let homeDir: string

// init's local credential check reads the token store; isolate it so tests
// never touch the developer's real Keychain / Secret Service.
const isolation = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: '',
})

const codexSkillPath = () =>
  join(workDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const claudeSkillPath = () =>
  join(workDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const userCodexSkillPath = () =>
  join(homeDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const userClaudeSkillPath = () =>
  join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const cursorRulePath = () =>
  join(workDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')
const userCursorSkillPath = () =>
  join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')

const runInit = (args: string[], env: Record<string, string> = {}) =>
  run(['init', ...args, '--json'], { ...isolation(), ...env }, { cwd: workDir })
const runInitFromHome = (args: string[], env: Record<string, string> = {}) =>
  run(['init', ...args, '--json'], { ...isolation(), ...env }, { cwd: homeDir })
const runSkills = (args: string[]) =>
  run(['skills', ...args, '--json'], isolation(), { cwd: workDir })
const runSkillsFromHome = (args: string[]) =>
  run(['skills', ...args, '--json'], isolation(), { cwd: homeDir })

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-init-work-'))
  workDir = await realpath(workDir)
  configHome = await mkdtemp(join(tmpdir(), 'artifactshare-cli-init-config-'))
  homeDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-init-home-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(configHome, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
})

test('init detects the agent in the working directory and installs its skill', async () => {
  await mkdir(join(workDir, '.claude'))

  const payload = expectSuccess(runInit([]), 'init')
  assert.equal(payload.data.mode, 'onboarding')
  assert.equal(payload.data.skills.dry_run, false)
  assert.deepEqual(
    payload.data.skills.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['claude', 'user', 'installed']],
  )
  assert.ok(await pathExists(userClaudeSkillPath()))
  assert.ok(!(await pathExists(claudeSkillPath())))
})

test('init detects Codex and installs Cursor user skill when .cursor exists', async () => {
  await mkdir(join(workDir, '.codex'))
  await mkdir(join(workDir, '.cursor'))

  const payload = expectSuccess(runInit([]), 'init')
  assert.deepEqual(
    payload.data.skills.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [
      ['codex', 'user', 'installed'],
      ['cursor', 'user', 'installed'],
    ],
  )
  assert.ok(await pathExists(userCodexSkillPath()))
  assert.ok(await pathExists(userCursorSkillPath()))
  assert.ok(!(await pathExists(codexSkillPath())))
  assert.ok(!(await pathExists(cursorRulePath())))
})

test('init falls back to Codex, Claude Code, and Cursor when no agent is detected', async () => {
  const payload = expectSuccess(runInit([]), 'init')
  assert.deepEqual(
    payload.data.skills.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [
      ['codex', 'user', 'installed'],
      ['claude', 'user', 'installed'],
      ['cursor', 'user', 'installed'],
    ],
  )
  assert.ok(await pathExists(userCodexSkillPath()))
  assert.ok(await pathExists(userClaudeSkillPath()))
  assert.ok(await pathExists(userCursorSkillPath()))
  assert.ok(!(await pathExists(codexSkillPath())))
  assert.ok(!(await pathExists(claudeSkillPath())))
})

test('init reports next steps and signed-out state by default', async () => {
  const payload = expectSuccess(runInit([]), 'init')
  assert.equal(payload.data.signed_in, false)
  const steps = payload.data.next_steps
  assert.deepEqual(
    steps.map((s: any) => s.id),
    ['login', 'share'],
  )
  const login = steps.find((s: any) => s.id === 'login')
  assert.equal(login.done, false)
  assert.equal(login.requires_browser_approval, true)
  assert.equal(login.awaits_user_action, true)
  assert.match(login.command, /-- artifactshare login --json/)
  const share = steps.find((s: any) => s.id === 'share')
  assert.match(share.command, /-- artifactshare share/)
})

test('init marks the sign-in step done when a token is available locally', async () => {
  const payload = expectSuccess(
    runInit([], { ARTIFACTSHARE_TOKEN: 'tok-123' }),
    'init',
  )
  assert.equal(payload.data.signed_in, true)
  const login = payload.data.next_steps.find((s: any) => s.id === 'login')
  assert.equal(login.done, true)
  assert.equal(login.requires_browser_approval, undefined)
  assert.equal(login.awaits_user_action, undefined)
  assert.match(login.command, /-- artifactshare login --json/)
  assert.ok(
    !JSON.stringify(payload).includes('tok-123'),
    'token values never appear in output',
  )
})

test('init --dry-run plans the skill install without writing', async () => {
  await mkdir(join(workDir, '.claude'))

  const payload = expectSuccess(runInit(['--dry-run']), 'init')
  assert.equal(payload.data.mode, 'onboarding')
  assert.equal(payload.data.skills.dry_run, true)
  assert.equal(payload.data.skills.targets[0].action, 'installed')
  assert.ok(!(await pathExists(userClaudeSkillPath())))
})

test('init updates outdated managed user skills', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'codex', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCodexSkillPath(), 'utf8')
  await writeLegacySkill(
    userCodexSkillPath(),
    installed.replace(/version: \d+/, 'version: 0'),
  )

  const payload = expectSuccess(runInit([]), 'init')
  assert.ok(
    payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'codex' &&
        target.scope === 'user' &&
        target.action === 'updated',
    ),
  )
  assert.equal(await readFile(userCodexSkillPath(), 'utf8'), installed)
})

test('init installs user scope skill without touching outdated project skill', async () => {
  await mkdir(join(workDir, '.codex'))
  expectSuccess(runSkills(['install', '--tool', 'codex']), 'skills install')
  const installed = await readFile(codexSkillPath(), 'utf8')
  const outdated = installed.replace(/version: \d+/, 'version: 0')
  await writeLegacySkill(codexSkillPath(), outdated)

  const payload = expectSuccess(runInit([]), 'init')
  assert.deepEqual(
    payload.data.skills.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['codex', 'user', 'installed']],
  )
  assert.ok(await pathExists(userCodexSkillPath()))
  assert.equal(await readFile(codexSkillPath(), 'utf8'), outdated)
})

test('init updates user scope skill without touching outdated project skill when cwd is home', async () => {
  await mkdir(join(homeDir, '.codex'))
  expectSuccess(
    runSkillsFromHome(['install', '--tool', 'codex']),
    'skills install',
  )
  const installed = await readFile(userCodexSkillPath(), 'utf8')
  const outdated = installed.replace(/version: \d+/, 'version: 0')
  await writeLegacySkill(userCodexSkillPath(), outdated)

  const payload = expectSuccess(runInitFromHome([]), 'init')
  assert.ok(
    payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'codex' &&
        target.scope === 'user' &&
        target.action === 'updated',
    ),
  )
  assert.ok(
    !payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'codex' &&
        target.scope === 'project' &&
        target.action === 'updated',
    ),
  )
  assert.equal(await readFile(userCodexSkillPath(), 'utf8'), installed)
})

test('init --dry-run reports outdated user skills without writing', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'codex', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCodexSkillPath(), 'utf8')
  const outdated = installed.replace(/version: \d+/, 'version: 0')
  await writeLegacySkill(userCodexSkillPath(), outdated)

  const payload = expectSuccess(runInit(['--dry-run']), 'init')
  assert.ok(
    payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'codex' &&
        target.scope === 'user' &&
        target.action === 'updated',
    ),
  )
  assert.equal(await readFile(userCodexSkillPath(), 'utf8'), outdated)
})

test('init continues without updating a broken managed user skill', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'codex', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCodexSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userCodexSkillPath(), broken)

  const payload = expectSuccess(runInit([]), 'init')
  assert.ok(
    !payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'codex' &&
        target.scope === 'user' &&
        target.action === 'updated',
    ),
  )
  assert.equal(await readFile(userCodexSkillPath(), 'utf8'), broken)
})

test('init fails with skill_update_conflict for an unmanaged user skill file', async () => {
  await mkdir(join(homeDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userClaudeSkillPath(), 'hand-written skill\n')

  const payload = expectFailure(runInit([]), {
    command: 'init',
    code: 'skill_update_conflict',
  })
  assert.equal(
    payload.error.details.path,
    join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(
    await readFile(userClaudeSkillPath(), 'utf8'),
    'hand-written skill\n',
  )
})

test('init fails with skill_update_conflict for an unmanaged user skill during detection', async () => {
  await mkdir(join(workDir, '.claude'))
  await mkdir(join(homeDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userClaudeSkillPath(), 'hand-written user skill\n')

  const payload = expectFailure(runInit([]), {
    command: 'init',
    code: 'skill_update_conflict',
  })
  assert.equal(
    payload.error.details.path,
    join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(
    await readFile(userClaudeSkillPath(), 'utf8'),
    'hand-written user skill\n',
  )
})

test('init continues without updating a broken managed cursor user skill', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCursorSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userCursorSkillPath(), broken)

  const payload = expectSuccess(runInit([]), 'init')
  assert.ok(
    !payload.data.skills.targets.some(
      (target: any) =>
        target.tool === 'cursor' &&
        target.scope === 'user' &&
        target.action === 'updated',
    ),
  )
  assert.equal(await readFile(userCursorSkillPath(), 'utf8'), broken)
})

test('init fails with skill_update_conflict for an unmanaged cursor user skill file', async () => {
  await mkdir(join(homeDir, '.cursor', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userCursorSkillPath(), 'hand-written skill\n')

  const payload = expectFailure(runInit([]), {
    command: 'init',
    code: 'skill_update_conflict',
  })
  assert.equal(
    payload.error.details.path,
    join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(
    await readFile(userCursorSkillPath(), 'utf8'),
    'hand-written skill\n',
  )
})

test('init fails with skill_update_conflict for an unmanaged cursor user skill during detection', async () => {
  await mkdir(join(workDir, '.cursor'))
  await mkdir(join(homeDir, '.cursor', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userCursorSkillPath(), 'hand-written user skill\n')

  const payload = expectFailure(runInit([]), {
    command: 'init',
    code: 'skill_update_conflict',
  })
  assert.equal(
    payload.error.details.path,
    join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(
    await readFile(userCursorSkillPath(), 'utf8'),
    'hand-written user skill\n',
  )
})

for (const value of ['absolute', 'relative', '', ' \t ']) {
  test(`init resolves Claude config ${JSON.stringify(value)}`, async () => {
    const root =
      value === 'absolute' ? join(homeDir, 'custom') : join(workDir, value)
    if (value.trim()) await mkdir(root, { recursive: true })
    // A project tool must not hide detection of the configured user root.
    await mkdir(join(workDir, '.cursor'))
    const result = expectSuccess(
      runInit([], { CLAUDE_CONFIG_DIR: value === 'absolute' ? root : value }),
    )
    const targets = result.data.skills.targets
    assert.deepEqual(
      targets.map((t: any) => t.tool),
      value.trim() ? ['claude', 'cursor'] : ['cursor'],
    )
    if (value.trim()) {
      const path = join(root, 'skills', 'artifactshare', 'SKILL.md')
      assert.equal(targets[0].path, path)
      assert.equal(
        await readFile(path, 'utf8'),
        await readFile(
          join(import.meta.dirname, '../skills/artifactshare/SKILL.md'),
          'utf8',
        ),
      )
    }
    assert.equal(await pathExists(userClaudeSkillPath()), false)
  })
}

for (const unmanaged of [false, true]) {
  test(`init ignores home Claude detection when config is unset (unmanaged: ${unmanaged})`, async () => {
    await mkdir(join(workDir, '.codex'))
    await mkdir(join(homeDir, '.claude'))
    const original = '# Hand-written skill\n'
    if (unmanaged) {
      await mkdir(join(homeDir, '.claude', 'skills', 'artifactshare'), {
        recursive: true,
      })
      await writeFile(userClaudeSkillPath(), original)
    }
    const payload = expectSuccess(runInit([]), 'init')
    assert.deepEqual(
      payload.data.skills.targets.map((target: any) => target.tool),
      ['codex'],
    )
    if (unmanaged) {
      assert.equal(await readFile(userClaudeSkillPath(), 'utf8'), original)
    } else {
      assert.equal(await pathExists(join(homeDir, '.claude', 'skills')), false)
    }
  })
}

async function writeLegacySkill(path: string, content: string) {
  await rm(join(dirname(path), 'references'), { recursive: true, force: true })
  await rm(join(dirname(path), '.artifactshare-managed.json'), { force: true })
  await writeFile(path, content)
}
