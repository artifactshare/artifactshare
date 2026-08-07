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
} from './test/helpers.js'

let workDir: string
let homeDir: string

const isolation = () => ({
  HOME: homeDir,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
})

const runSkills = (args: string[]) =>
  run(['skills', ...args, '--json'], isolation(), { cwd: workDir })

const userCodexSkillPath = () =>
  join(homeDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const userClaudeSkillPath = () =>
  join(homeDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const codexSkillPath = () =>
  join(workDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
const claudeSkillPath = () =>
  join(workDir, '.claude', 'skills', 'artifactshare', 'SKILL.md')
const cursorRulePath = () =>
  join(workDir, '.cursor', 'rules', 'artifactshare.mdc')
const userCursorSkillPath = () =>
  join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md')

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-skills-work-'))
  homeDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-skills-home-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
})

test('skills install writes managed skill files for each tool', async () => {
  const payload = expectSuccess(
    runSkills([
      'install',
      '--tool',
      'codex',
      '--tool',
      'claude',
      '--tool',
      'cursor',
    ]),
    'skills install',
  )
  assert.equal(payload.data.dry_run, false)
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [
      ['codex', 'project', 'installed'],
      ['claude', 'project', 'installed'],
      ['cursor', 'project', 'installed'],
    ],
  )
  const codexSkill = await readFile(codexSkillPath(), 'utf8')
  assert.ok(codexSkill.includes('artifactshare-skill'))
  assert.ok(codexSkill.includes('version: 33'))
  assert.ok(codexSkill.includes('npx --yes @artifactshare/cli'))
  assert.ok(codexSkill.includes('Share, publish, upload, host'))
  assert.ok(codexSkill.includes('return a browser link'))
  assert.ok(codexSkill.includes('update the same URL'))
  assert.ok(codexSkill.includes('as でアップして'))
  assert.ok(codexSkill.includes('as に上げて'))
  assert.ok(codexSkill.includes('bare English "as" alone is not'))
  assert.ok(codexSkill.includes('Do not use this skill just because'))
  assert.ok(codexSkill.includes('Claude Artifact is'))
  assert.ok(
    codexSkill.includes('Honor an explicit user request to use CLI or MCP'),
  )
  assert.ok(codexSkill.includes('before selecting the default'))
  assert.ok(codexSkill.includes('do not run `share --artifact-id`'))
  assert.ok(codexSkill.includes('share <path> --key <key> --json'))
  assert.ok(codexSkill.includes('give the user `data.artifact.url`'))
  assert.ok(codexSkill.includes('Do not rerun `share`'))
  assert.ok(codexSkill.includes('--scope user --json'))
  assert.ok(codexSkill.includes('--scope effective --json'))
  assert.ok(codexSkill.includes('policy agreed by all participants'))
  assert.ok(codexSkill.includes('open <artifact-id-or-url> --json'))
  assert.ok(codexSkill.includes('edit <artifact-id-or-url> --title'))
  assert.ok(codexSkill.includes('delete <artifact-id-or-url> --json'))
  assert.ok(codexSkill.includes('logout --profile <name> --json'))
  assert.ok(codexSkill.includes('profiles delete <name> --json'))
  assert.ok(codexSkill.includes('https://artifactshare.com/settings/tokens'))
  assert.ok(
    codexSkill.includes(
      'remote MCP for source text in chat or a temporary sandbox',
    ),
  )
  assert.ok(codexSkill.includes('--agent'))
  assert.ok(codexSkill.includes('--quote'))
  assert.ok(codexSkill.includes('--include versions'))
  assert.ok(codexSkill.includes('data.content'))
  assert.ok(codexSkill.includes('data.version_id'))
  assert.ok(codexSkill.includes('skills ensure'))
  assert.ok(!codexSkill.includes('@artifactshare/cli@'))
  assert.equal(await readFile(claudeSkillPath(), 'utf8'), codexSkill)
  const cursorRule = await readFile(cursorRulePath(), 'utf8')
  assert.ok(cursorRule.includes('artifactshare-skill'))
  assert.ok(cursorRule.includes('version: 33'))
  assert.ok(cursorRule.includes('Share, publish, upload, host'))
  assert.ok(cursorRule.includes('return a browser link'))
  assert.ok(cursorRule.includes('update the same URL'))
  assert.ok(cursorRule.includes('as でアップして'))
  assert.ok(cursorRule.includes('as に上げて'))
  assert.ok(cursorRule.includes('bare English "as" alone is not'))
  assert.ok(cursorRule.includes('Do not use this rule just because'))
  assert.ok(cursorRule.includes('Claude Artifact is'))
  assert.ok(cursorRule.includes('A user-named CLI or MCP route overrides'))
  assert.ok(cursorRule.includes('automatic capability selection'))
  assert.ok(cursorRule.includes('do not use `share --artifact-id`'))
  assert.ok(cursorRule.includes('share <path> --key <key> --json'))
  assert.ok(cursorRule.includes('give the user `data.artifact.url`'))
  assert.ok(cursorRule.includes('Do not rerun `share`'))
  assert.ok(cursorRule.includes('--scope user --json'))
  assert.ok(cursorRule.includes('--scope effective --json'))
  assert.ok(cursorRule.includes('policy agreed by all participants'))
  assert.ok(cursorRule.includes('open <artifact-id-or-url> --json'))
  assert.ok(cursorRule.includes('edit <target>'))
  assert.ok(cursorRule.includes('delete <artifact-id-or-url> --json'))
  assert.ok(cursorRule.includes('logout --profile <name> --json'))
  assert.ok(cursorRule.includes('profiles delete <name> --json'))
  assert.ok(cursorRule.includes('https://artifactshare.com/settings/tokens'))
  assert.ok(cursorRule.includes('remote MCP for source text in chat or'))
  assert.ok(cursorRule.includes('temporary sandbox'))
  assert.ok(cursorRule.includes('data.content'))
  assert.ok(cursorRule.includes('data.version_id'))
  assert.ok(cursorRule.includes('--agent'))
  assert.ok(cursorRule.includes('--quote'))
  assert.ok(cursorRule.includes('--include versions'))
  assert.ok(cursorRule.includes('skills ensure'))
  assert.ok(cursorRule.includes('alwaysApply'))
})

test('skills install --scope user writes under the home directory', async () => {
  const payload = expectSuccess(
    runSkills(['install', '--tool', 'codex', '--scope', 'user']),
    'skills install',
  )
  const target = payload.data.targets[0]
  assert.equal(target.scope, 'user')
  const path = join(homeDir, '.agents', 'skills', 'artifactshare', 'SKILL.md')
  assert.equal(target.path, path)
  assert.ok(await pathExists(path))
})

test('skills install --tool cursor --scope project writes artifactshare.mdc and keeps .cursor on remove', async () => {
  const payload = expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'project']),
    'skills install',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['cursor', 'project', 'installed']],
  )
  const rule = await readFile(cursorRulePath(), 'utf8')
  assert.ok(rule.includes('artifactshare-skill'))
  assert.ok(rule.includes('version: 33'))
  assert.ok(rule.includes('alwaysApply'))
  assert.ok(!(await pathExists(userCursorSkillPath())))

  const removed = expectSuccess(
    runSkills(['remove', '--tool', 'cursor', '--scope', 'project']),
    'skills remove',
  )
  assert.equal(removed.data.targets[0].action, 'removed')
  assert.ok(!(await pathExists(cursorRulePath())))
  assert.ok(await pathExists(join(workDir, '.cursor')))
  assert.ok(await pathExists(join(workDir, '.cursor', 'rules')))
})

test('skills install --tool cursor --scope user writes SKILL.md under home', async () => {
  const payload = expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user']),
    'skills install',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['cursor', 'user', 'installed']],
  )
  const skill = await readFile(userCursorSkillPath(), 'utf8')
  assert.ok(skill.includes('artifactshare-skill'))
  assert.ok(skill.includes('version: 33'))
  assert.ok(skill.includes('Do not use this skill just because'))
  assert.ok(!skill.includes('alwaysApply'))
  assert.ok(!(await pathExists(cursorRulePath())))
})

test('skills install --dry-run reports the plan without writing', async () => {
  const payload = expectSuccess(
    runSkills(['install', '--tool', 'codex', '--dry-run']),
    'skills install',
  )
  assert.equal(payload.data.dry_run, true)
  assert.equal(payload.data.targets[0].action, 'installed')
  assert.ok(!(await pathExists(join(workDir, '.agents'))))
})

test('skills install rejects missing or unknown --tool and bad --scope', async () => {
  expectFailure(runSkills(['install']), {
    command: 'skills install',
    code: 'validation_failed',
  })
  expectFailure(runSkills(['install', '--tool', 'emacs']), {
    command: 'skills install',
    code: 'validation_failed',
  })
  expectFailure(
    runSkills(['install', '--tool', 'codex', '--scope', 'global']),
    {
      command: 'skills install',
      code: 'validation_failed',
    },
  )
})

test('skills update and remove reject blank filters instead of widening', async () => {
  expectFailure(runSkills(['remove', '--tool', ' ']), {
    command: 'skills remove',
    code: 'validation_failed',
  })
})

test('skills install never overwrites an unmanaged file without --force', async () => {
  await mkdir(join(workDir, '.cursor', 'rules'), { recursive: true })
  await writeFile(cursorRulePath(), 'my own rule\n')

  const payload = expectFailure(
    runSkills(['install', '--tool', 'codex', '--tool', 'cursor']),
    { command: 'skills install', code: 'skill_update_conflict' },
  )
  assert.equal(
    payload.error.details.path,
    join('.cursor', 'rules', 'artifactshare.mdc'),
  )
  assert.equal(await readFile(cursorRulePath(), 'utf8'), 'my own rule\n')
  assert.ok(
    !(await pathExists(codexSkillPath())),
    'a conflict blocks every target',
  )

  const forced = expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--force']),
    'skills install',
  )
  assert.equal(forced.data.targets[0].action, 'updated')
  assert.ok(
    (await readFile(cursorRulePath(), 'utf8')).includes('artifactshare-skill'),
  )
})

test('skills install is unchanged when the same version is already installed', async () => {
  expectSuccess(runSkills(['install', '--tool', 'codex']), 'skills install')
  const payload = expectSuccess(
    runSkills(['install', '--tool', 'codex']),
    'skills install',
  )
  assert.equal(payload.data.targets[0].action, 'unchanged')
})

test('skills ensure installs missing and updates outdated managed skills', async () => {
  const installed = expectSuccess(
    runSkills(['ensure', '--tool', 'codex']),
    'skills ensure',
  )
  assert.equal(installed.data.targets[0].action, 'installed')
  const original = await readFile(codexSkillPath(), 'utf8')
  await writeFile(
    codexSkillPath(),
    original.replace(/version: \d+/, 'version: 0'),
  )

  const updated = expectSuccess(
    runSkills(['ensure', '--tool', 'codex']),
    'skills ensure',
  )
  assert.equal(updated.data.targets[0].action, 'updated')
  assert.equal(await readFile(codexSkillPath(), 'utf8'), original)

  const unchanged = expectSuccess(
    runSkills(['ensure', '--tool', 'codex']),
    'skills ensure',
  )
  assert.equal(unchanged.data.targets[0].action, 'unchanged')
})

test('skills ensure --tool auto detects Claude Code projects', async () => {
  await mkdir(join(workDir, '.claude'))

  const payload = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['claude', 'user', 'installed']],
  )
  assert.ok(await pathExists(userClaudeSkillPath()))
  assert.ok(!(await pathExists(claudeSkillPath())))
  assert.ok(!(await pathExists(codexSkillPath())))
})

test('skills ensure --tool auto detects Cursor projects', async () => {
  await mkdir(join(workDir, '.cursor'))

  const payload = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [['cursor', 'user', 'installed']],
  )
  assert.ok(await pathExists(userCursorSkillPath()))
  assert.ok(!(await pathExists(cursorRulePath())))
})

test('skills ensure --tool auto updates outdated user skills explicitly', async () => {
  await mkdir(join(workDir, '.claude'))
  const installed = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.equal(installed.data.targets[0].action, 'installed')
  const original = await readFile(userClaudeSkillPath(), 'utf8')
  await writeFile(
    userClaudeSkillPath(),
    original.replace(/version: \d+/, 'version: 0'),
  )

  const updated = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.equal(updated.data.targets[0].action, 'updated')
  assert.equal(await readFile(userClaudeSkillPath(), 'utf8'), original)
})

test('skills ensure --tool auto detects Codex and installs Cursor user skill when .cursor exists', async () => {
  await mkdir(join(workDir, '.codex'))
  await mkdir(join(workDir, '.cursor'))

  const payload = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [
      ['codex', 'user', 'installed'],
      ['cursor', 'user', 'installed'],
    ],
  )
  assert.ok(await pathExists(userCodexSkillPath()))
  assert.ok(await pathExists(userCursorSkillPath()))
  assert.ok(!(await pathExists(codexSkillPath())))
  assert.ok(!(await pathExists(cursorRulePath())))
  assert.ok(!(await pathExists(claudeSkillPath())))
})

test('skills ensure --tool auto falls back to Codex, Claude, and Cursor user skills', async () => {
  const payload = expectSuccess(
    runSkills(['ensure', '--tool', 'auto']),
    'skills ensure',
  )
  assert.deepEqual(
    payload.data.targets.map((t: any) => [t.tool, t.scope, t.action]),
    [
      ['codex', 'user', 'installed'],
      ['claude', 'user', 'installed'],
      ['cursor', 'user', 'installed'],
    ],
  )
})

test('skills ensure rejects unmanaged or broken files without overwriting', async () => {
  await mkdir(join(workDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(claudeSkillPath(), 'hand-written skill\n')

  const payload = expectFailure(runSkills(['ensure', '--tool', 'claude']), {
    command: 'skills ensure',
    code: 'skill_update_conflict',
  })
  assert.equal(
    payload.error.details.path,
    join('.claude', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(
    await readFile(claudeSkillPath(), 'utf8'),
    'hand-written skill\n',
  )
})

test('only skills ensure accepts --tool auto', async () => {
  expectFailure(runSkills(['install', '--tool', 'auto']), {
    command: 'skills install',
    code: 'validation_failed',
  })
  expectFailure(runSkills(['update', '--tool', 'auto']), {
    command: 'skills update',
    code: 'validation_failed',
  })
  expectFailure(runSkills(['remove', '--tool', 'auto']), {
    command: 'skills remove',
    code: 'validation_failed',
  })
  expectFailure(runSkills(['ensure', '--tool', 'auto', '--scope', 'project']), {
    command: 'skills ensure',
    code: 'validation_failed',
  })
  expectSuccess(
    runSkills(['ensure', '--tool', 'auto', '--scope', 'user']),
    'skills ensure',
  )
})

test('skills ensure --tool auto fails on a broken managed user skill', async () => {
  await mkdir(join(workDir, '.claude'))
  expectSuccess(
    runSkills(['install', '--tool', 'claude', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userClaudeSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userClaudeSkillPath(), broken)

  expectFailure(runSkills(['ensure', '--tool', 'auto']), {
    command: 'skills ensure',
    code: 'skill_update_conflict',
  })
  assert.equal(await readFile(userClaudeSkillPath(), 'utf8'), broken)
})

test('skills list reports detection, install state, and update availability', async () => {
  expectSuccess(runSkills(['install', '--tool', 'codex']), 'skills install')
  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'project']),
    'skills install',
  )
  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user']),
    'skills install',
  )

  const payload = expectSuccess(runSkills(['list']), 'skills list')
  assert.equal(typeof payload.data.bundled_version, 'number')
  assert.equal(payload.data.targets.length, 6)

  const codexProject = payload.data.targets.find(
    (t: any) => t.tool === 'codex' && t.scope === 'project',
  )
  assert.deepEqual(codexProject, {
    tool: 'codex',
    scope: 'project',
    path: join('.agents', 'skills', 'artifactshare', 'SKILL.md'),
    detected: true,
    installed: true,
    managed: true,
    installed_version: payload.data.bundled_version,
    update_available: false,
  })
  const claudeProject = payload.data.targets.find(
    (t: any) => t.tool === 'claude' && t.scope === 'project',
  )
  assert.equal(claudeProject.detected, false)
  assert.equal(claudeProject.installed, false)
  assert.equal(claudeProject.installed_version, null)
  const cursorUser = payload.data.targets.find(
    (t: any) => t.tool === 'cursor' && t.scope === 'user',
  )
  assert.equal(
    cursorUser.path,
    join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md'),
  )
  assert.equal(cursorUser.installed, true)
  assert.equal(cursorUser.managed, true)
  const cursorProject = payload.data.targets.find(
    (t: any) => t.tool === 'cursor' && t.scope === 'project',
  )
  assert.equal(
    cursorProject.path,
    join('.cursor', 'rules', 'artifactshare.mdc'),
  )
  assert.equal(cursorProject.installed, true)
  assert.equal(cursorProject.managed, true)
})

test('skills update rewrites outdated managed files and skips unmanaged ones', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'codex', '--tool', 'claude']),
    'skills install',
  )
  const installed = await readFile(codexSkillPath(), 'utf8')
  await writeFile(
    codexSkillPath(),
    installed.replace(/version: \d+/, 'version: 0'),
  )
  await mkdir(join(workDir, '.cursor', 'rules'), { recursive: true })
  await writeFile(cursorRulePath(), 'my own rule\n')

  const payload = expectSuccess(runSkills(['update']), 'skills update')
  const actions = Object.fromEntries(
    payload.data.targets.map((t: any) => [`${t.tool}:${t.scope}`, t.action]),
  )
  assert.equal(actions['codex:project'], 'updated')
  assert.equal(actions['claude:project'], 'unchanged')
  assert.equal(actions['cursor:project'], 'skipped_unmanaged')
  assert.equal(actions['codex:user'], 'not_installed')
  assert.equal(await readFile(codexSkillPath(), 'utf8'), installed)
  assert.equal(await readFile(cursorRulePath(), 'utf8'), 'my own rule\n')
})

test('skills update fails on a broken managed marker', async () => {
  expectSuccess(runSkills(['install', '--tool', 'codex']), 'skills install')
  const installed = await readFile(codexSkillPath(), 'utf8')
  await writeFile(
    codexSkillPath(),
    installed.replace(/version: \d+/, 'version: x'),
  )

  expectFailure(runSkills(['update']), {
    command: 'skills update',
    code: 'skill_update_conflict',
  })
})

test('skills remove deletes only managed files and cleans up skill directories', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'codex', '--tool', 'cursor']),
    'skills install',
  )
  await mkdir(join(workDir, '.claude', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(claudeSkillPath(), 'hand-written skill\n')

  const payload = expectSuccess(runSkills(['remove']), 'skills remove')
  const actions = Object.fromEntries(
    payload.data.targets.map((t: any) => [`${t.tool}:${t.scope}`, t.action]),
  )
  assert.equal(actions['codex:project'], 'removed')
  assert.equal(actions['cursor:project'], 'removed')
  assert.equal(actions['claude:project'], 'skipped_unmanaged')
  assert.ok(!(await pathExists(join(workDir, '.agents', 'skills'))))
  assert.ok(await pathExists(join(workDir, '.agents')))
  assert.equal(
    await readFile(claudeSkillPath(), 'utf8'),
    'hand-written skill\n',
  )
})

test('skills remove --dry-run keeps files in place', async () => {
  expectSuccess(runSkills(['install', '--tool', 'codex']), 'skills install')
  const payload = expectSuccess(
    runSkills(['remove', '--tool', 'codex', '--dry-run']),
    'skills remove',
  )
  assert.equal(payload.data.dry_run, true)
  assert.equal(payload.data.targets[0].action, 'removed')
  assert.ok(await pathExists(codexSkillPath()))
})

test('skills update and remove handle cursor user scope targets', async () => {
  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user']),
    'skills install',
  )
  const installed = await readFile(userCursorSkillPath(), 'utf8')
  await writeFile(
    userCursorSkillPath(),
    installed.replace(/version: \d+/, 'version: 0'),
  )

  const updated = expectSuccess(
    runSkills(['update', '--tool', 'cursor', '--scope', 'user']),
    'skills update',
  )
  assert.equal(updated.data.targets[0].action, 'updated')
  assert.equal(await readFile(userCursorSkillPath(), 'utf8'), installed)

  const removed = expectSuccess(
    runSkills(['remove', '--tool', 'cursor', '--scope', 'user']),
    'skills remove',
  )
  assert.equal(removed.data.targets[0].action, 'removed')
  assert.ok(!(await pathExists(userCursorSkillPath())))
  assert.ok(
    !(await pathExists(join(homeDir, '.cursor', 'skills', 'artifactshare'))),
  )
  assert.ok(!(await pathExists(join(homeDir, '.cursor', 'skills'))))
  assert.ok(await pathExists(join(homeDir, '.cursor')))
})

test('skills ensure rejects unmanaged or broken cursor user skills', async () => {
  await mkdir(join(homeDir, '.cursor', 'skills', 'artifactshare'), {
    recursive: true,
  })
  await writeFile(userCursorSkillPath(), 'hand-written skill\n')

  const unmanaged = expectFailure(
    runSkills(['ensure', '--tool', 'cursor', '--scope', 'user']),
    { command: 'skills ensure', code: 'skill_update_conflict' },
  )
  assert.equal(
    unmanaged.error.details.path,
    join(homeDir, '.cursor', 'skills', 'artifactshare', 'SKILL.md'),
  )

  expectSuccess(
    runSkills(['install', '--tool', 'cursor', '--scope', 'user', '--force']),
    'skills install',
  )
  const installed = await readFile(userCursorSkillPath(), 'utf8')
  const broken = installed.replace(/version: \d+/, 'version: x')
  await writeFile(userCursorSkillPath(), broken)

  expectFailure(runSkills(['ensure', '--tool', 'cursor', '--scope', 'user']), {
    command: 'skills ensure',
    code: 'skill_update_conflict',
  })
  assert.equal(await readFile(userCursorSkillPath(), 'utf8'), broken)
})

test('skills without a subcommand fails with guidance', async () => {
  expectFailure(runSkills([]), {
    command: 'skills',
    code: 'validation_failed',
  })
})
