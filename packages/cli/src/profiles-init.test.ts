import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { expectFailure, expectSuccess, run } from './test/helpers.js'

let configHome: string
let workDir: string

const isolation = () => ({
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: '',
})

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'artifactshare-cli-config-'))
  workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-work-'))
})

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

async function writeGlobalConfig(config: unknown): Promise<void> {
  await writeFile(join(configHome, 'config.json'), JSON.stringify(config))
}

test('profile commands report an unresolved config home separately', () => {
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: '',
    XDG_CONFIG_HOME: '',
    HOME: '',
    USERPROFILE: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    ARTIFACTSHARE_TOKEN: '',
  }
  const cases: Array<{ args: string[]; input?: string }> = [
    { args: ['profiles', 'list', '--json'] },
    { args: ['profiles', 'use', 'client-a', '--json'] },
    {
      args: ['profiles', 'import-token', '--profile', 'client-a', '--json'],
      input: 'test-token',
    },
    { args: ['profiles', 'delete', 'client-a', '--json'] },
  ]
  for (const { args, input } of cases) {
    const payload = expectFailure(
      run(args, env, input === undefined ? {} : { input }),
      { code: 'config_home_unavailable' },
    )
    assert.equal(payload.error.details.cause, 'config_home_unresolved')
  }
})

test('profiles list returns saved profiles, default state, and token presence', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: {
      'client-a': {
        base_url: 'https://example.com',
        email: 'a@example.com',
        workspace_id: 'wrk1',
        token_store: 'plaintext_file',
        updated_at: '2026-06-10T00:00:00Z',
      },
      personal: { base_url: 'https://example.com' },
    },
  })
  await writeFile(
    join(configHome, 'tokens.json'),
    JSON.stringify({
      'https://example.com:client-a': JSON.stringify({
        kind: 'api_token',
        token: 'tok-a',
      }),
    }),
  )

  const payload = expectSuccess(
    run(['profiles', 'list', '--json'], isolation()),
    'profiles list',
  )
  assert.equal(payload.data.default_profile, 'client-a')
  assert.deepEqual(payload.data.profiles, [
    {
      name: 'client-a',
      base_url: 'https://example.com',
      email: 'a@example.com',
      workspace_id: 'wrk1',
      token_store: 'plaintext_file',
      updated_at: '2026-06-10T00:00:00Z',
      is_default: true,
      token_present: true,
    },
    {
      name: 'personal',
      base_url: 'https://example.com',
      email: null,
      workspace_id: null,
      token_store: null,
      updated_at: null,
      is_default: false,
      token_present: false,
    },
  ])
  assert.ok(
    !JSON.stringify(payload).includes('tok-a'),
    'token values never appear in output',
  )
})

test('profiles list succeeds with no saved profiles', async () => {
  const payload = expectSuccess(
    run(['profiles', 'list', '--json'], isolation()),
    'profiles list',
  )
  assert.deepEqual(payload.data, { default_profile: null, profiles: [] })
})

test('profiles list survives a malformed null profile entry', async () => {
  await writeGlobalConfig({ profiles: { bad: null, good: {} } })

  const payload = expectSuccess(
    run(['profiles', 'list', '--json'], isolation()),
    'profiles list',
  )
  assert.deepEqual(
    payload.data.profiles.map((entry: { name: string }) => entry.name),
    ['bad', 'good'],
  )
})

test('profiles list keys token lookup by the profile base_url, not --base-url', async () => {
  await writeGlobalConfig({ profiles: { p: {} } })
  await writeFile(
    join(configHome, 'tokens.json'),
    JSON.stringify({ 'https://other.example:p': 'tok-other' }),
  )

  const payload = expectSuccess(
    run(
      ['profiles', 'list', '--base-url', 'https://other.example', '--json'],
      isolation(),
    ),
    'profiles list',
  )
  assert.equal(payload.data.profiles[0].token_present, false)
})

test('profiles use switches the default profile and keeps profile entries', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': {}, personal: { email: 'p@example.com' } },
  })

  const payload = expectSuccess(
    run(['profiles', 'use', 'personal', '--json'], isolation()),
    'profiles use',
  )
  assert.deepEqual(payload.data, {
    default_profile: 'personal',
    previous_default: 'client-a',
  })

  const config = JSON.parse(
    await readFile(join(configHome, 'config.json'), 'utf8'),
  )
  assert.equal(config.default_profile, 'personal')
  assert.deepEqual(config.profiles.personal, { email: 'p@example.com' })
})

test('profiles use fails with profile_not_found for an unknown name', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  const payload = expectFailure(
    run(['profiles', 'use', 'nope', '--json'], isolation()),
    { command: 'profiles use', code: 'profile_not_found' },
  )
  assert.equal(payload.error.details.profile, 'nope')
})

test('profiles use rejects inherited object keys as profile names', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  for (const name of ['constructor', 'toString', '__proto__']) {
    expectFailure(run(['profiles', 'use', name, '--json'], isolation()), {
      command: 'profiles use',
      code: 'profile_not_found',
    })
  }
})

test('profiles use works when a value flag precedes the command', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': {}, personal: {} },
  })

  const payload = expectSuccess(
    run(
      [
        '--base-url',
        'https://example.com',
        'profiles',
        'use',
        'personal',
        '--json',
      ],
      isolation(),
    ),
    'profiles use',
  )
  assert.equal(payload.data.default_profile, 'personal')
})

test('profiles use without a name fails validation', async () => {
  expectFailure(run(['profiles', 'use', '--json'], isolation()), {
    command: 'profiles use',
    code: 'validation_failed',
  })
})

test('profiles delete without a name fails validation', async () => {
  expectFailure(run(['profiles', 'delete', '--json'], isolation()), {
    command: 'profiles delete',
    code: 'validation_failed',
  })
})

test('init writes working-directory defaults to config.local.json and validates the profile', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  const payload = expectSuccess(
    run(
      ['init', '--profile', 'client-a', '--project-id', 'prj1', '--json'],
      isolation(),
      { cwd: workDir },
    ),
    'init',
  )
  assert.deepEqual(payload.data, {
    mode: 'config',
    path: '.artifactshare/config.local.json',
    written: true,
    config: { default_profile: 'client-a', default_project_id: 'prj1' },
  })

  const saved = JSON.parse(
    await readFile(join(workDir, '.artifactshare/config.local.json'), 'utf8'),
  )
  assert.deepEqual(saved, {
    default_profile: 'client-a',
    default_project_id: 'prj1',
  })
})

test('init adds config.local.json to .git/info/exclude inside a git repo', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })
  await mkdir(join(workDir, '.git', 'info'), { recursive: true })
  await writeFile(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  const payload = expectSuccess(
    run(['init', '--profile', 'client-a', '--json'], isolation(), {
      cwd: workDir,
    }),
    'init',
  )
  assert.equal(payload.data.git_exclude_applied, true)

  const exclude = await readFile(
    join(workDir, '.git', 'info', 'exclude'),
    'utf8',
  )
  assert.equal(exclude.trim().split('\n').filter(Boolean).length, 1)
  assert.ok(exclude.includes('.artifactshare/config.local.json'))
})

test('init does not duplicate .git/info/exclude entries', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })
  await mkdir(join(workDir, '.git', 'info'), { recursive: true })
  await writeFile(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(
    join(workDir, '.git', 'info', 'exclude'),
    '.artifactshare/config.local.json\n',
  )

  const payload = expectSuccess(
    run(['init', '--profile', 'client-a', '--json'], isolation(), {
      cwd: workDir,
    }),
    'init',
  )
  assert.equal(payload.data.git_exclude_applied, undefined)

  const exclude = await readFile(
    join(workDir, '.git', 'info', 'exclude'),
    'utf8',
  )
  assert.equal(
    exclude
      .split('\n')
      .filter((line) => line === '.artifactshare/config.local.json').length,
    1,
  )
})

test('init excludes config.local.json relative to the git worktree root', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })
  const subDir = join(workDir, 'sub')
  await mkdir(join(workDir, '.git', 'info'), { recursive: true })
  await mkdir(subDir)
  await writeFile(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  const payload = expectSuccess(
    run(['init', '--profile', 'client-a', '--json'], isolation(), {
      cwd: subDir,
    }),
    'init',
  )
  assert.equal(payload.data.git_exclude_applied, true)

  const exclude = await readFile(
    join(workDir, '.git', 'info', 'exclude'),
    'utf8',
  )
  assert.ok(exclude.includes('sub/.artifactshare/config.local.json'))
})

test('init uses git commondir for linked worktree exclude files', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })
  const commonDir = join(workDir, 'common.git')
  const linkedDir = join(workDir, 'linked')
  const linkedGitDir = join(commonDir, 'worktrees', 'linked')
  await mkdir(join(commonDir, 'info'), { recursive: true })
  await mkdir(linkedGitDir, { recursive: true })
  await mkdir(linkedDir)
  await writeFile(join(linkedDir, '.git'), `gitdir: ${linkedGitDir}\n`)
  await writeFile(join(linkedGitDir, 'commondir'), '../..\n')

  const payload = expectSuccess(
    run(['init', '--profile', 'client-a', '--json'], isolation(), {
      cwd: linkedDir,
    }),
    'init',
  )
  assert.equal(payload.data.git_exclude_applied, true)

  const exclude = await readFile(join(commonDir, 'info', 'exclude'), 'utf8')
  assert.ok(exclude.includes('.artifactshare/config.local.json'))
})

test('init rejects a profile that is not saved', async () => {
  expectFailure(
    run(['init', '--profile', 'ghost', '--json'], isolation(), {
      cwd: workDir,
    }),
    { command: 'init', code: 'profile_not_found' },
  )
})

test('init rejects inherited object keys as profile names', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  expectFailure(
    run(['init', '--profile', 'constructor', '--json'], isolation(), {
      cwd: workDir,
    }),
    { command: 'init', code: 'profile_not_found' },
  )
})

test('init --profile distinguishes an unresolved config home from a missing native store', async () => {
  const payload = expectFailure(
    run(
      ['init', '--profile', 'client-a', '--json'],
      {
        ARTIFACTSHARE_CONFIG_HOME: '',
        XDG_CONFIG_HOME: '',
        HOME: '',
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        ARTIFACTSHARE_TOKEN: '',
      },
      { cwd: workDir },
    ),
    { command: 'init', code: 'config_home_unavailable' },
  )
  assert.equal(payload.error.details.cause, 'config_home_unresolved')
})

test('init rejects --dry-run combined with config flags instead of writing', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  expectFailure(
    run(
      [
        'init',
        '--profile',
        'client-a',
        '--project-id',
        'prj1',
        '--dry-run',
        '--json',
      ],
      isolation(),
      { cwd: workDir },
    ),
    { command: 'init', code: 'validation_failed' },
  )
  const saved = await readFile(
    join(workDir, '.artifactshare/config.local.json'),
    'utf8',
  ).catch(() => null)
  assert.equal(saved, null)
})

test('init --profile saves config defaults and installs no skill files', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  const payload = expectSuccess(
    run(
      ['init', '--profile', 'client-a', '--project-id', 'prj1', '--json'],
      isolation(),
      {
        cwd: workDir,
      },
    ),
    'init',
  )
  assert.equal(payload.data.mode, 'config')
  assert.equal(payload.data.written, true)
  // The config-save path must not touch agent skills.
  const codexSkill = await readFile(
    join(workDir, '.agents', 'skills', 'artifactshare', 'SKILL.md'),
    'utf8',
  ).catch(() => null)
  const claudeSkill = await readFile(
    join(workDir, '.claude', 'skills', 'artifactshare', 'SKILL.md'),
    'utf8',
  ).catch(() => null)
  assert.equal(codexSkill, null)
  assert.equal(claudeSkill, null)
})

test('init updates one key and preserves the rest of config.local.json', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.local.json'),
    JSON.stringify({ default_project_id: 'prj-old', custom: 'kept' }),
  )

  const payload = expectSuccess(
    run(['init', '--profile', 'client-a', '--json'], isolation(), {
      cwd: workDir,
    }),
    'init',
  )
  assert.deepEqual(payload.data.config, {
    default_profile: 'client-a',
    default_project_id: 'prj-old',
  })
  const saved = JSON.parse(
    await readFile(join(workDir, '.artifactshare/config.local.json'), 'utf8'),
  )
  assert.equal(saved.custom, 'kept')
})

test('config.local.json is preferred over config.json in the same directory', async () => {
  await writeGlobalConfig({ profiles: { local: {}, shared: {} } })
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.local.json'),
    JSON.stringify({ default_profile: 'local' }),
  )
  await writeFile(
    join(workDir, '.artifactshare/config.json'),
    JSON.stringify({ default_profile: 'shared' }),
  )

  const payload = expectSuccess(
    run(['doctor', '--json'], isolation(), { cwd: workDir }),
    'doctor',
  )
  assert.equal(payload.data.auth.credential_source, 'local_config')
  assert.equal(payload.data.auth.profile, 'local')
})

test('child config.json wins over parent config.local.json', async () => {
  const parentDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-parent-'))
  const childDir = join(parentDir, 'child')
  await mkdir(join(parentDir, '.artifactshare'))
  await mkdir(childDir)
  await mkdir(join(childDir, '.artifactshare'))
  await writeGlobalConfig({ profiles: { child: {}, parent: {} } })
  await writeFile(
    join(parentDir, '.artifactshare/config.local.json'),
    JSON.stringify({ default_profile: 'parent' }),
  )
  await writeFile(
    join(childDir, '.artifactshare/config.json'),
    JSON.stringify({ default_profile: 'child' }),
  )

  try {
    const payload = expectFailure(
      run(['whoami', '--json'], isolation(), { cwd: childDir }),
      { command: 'whoami', code: 'auth_required' },
    )
    assert.equal(payload.error.details.credential_source, 'project_config')
    assert.equal(payload.error.details.profile, 'child')
  } finally {
    await rm(parentDir, { recursive: true, force: true })
  }
})

test('doctor reports local, project, global, and effective config state', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': {}, personal: {} },
  })
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.local.json'),
    JSON.stringify({
      default_profile: 'client-a',
      default_project_id: 'prj1',
    }),
  )

  const payload = expectSuccess(
    run(['doctor', '--json'], isolation(), { cwd: workDir }),
    'doctor',
  )
  assert.deepEqual(payload.data.config.local, {
    present: true,
    path: '.artifactshare/config.local.json',
    default_profile: 'client-a',
    default_project_id: 'prj1',
  })
  assert.deepEqual(payload.data.config.project, {
    present: false,
    path: '.artifactshare/config.json',
    default_profile: null,
    default_project_id: null,
  })
  assert.deepEqual(payload.data.config.global, {
    present: true,
    default_profile: 'client-a',
    profile_count: 2,
  })
  assert.deepEqual(payload.data.config.effective, {
    default_profile: 'client-a',
    default_profile_source: 'local',
    default_profile_path: '.artifactshare/config.local.json',
    default_project_id: 'prj1',
    default_project_id_source: 'local',
    default_project_id_path: '.artifactshare/config.local.json',
  })
})

test('doctor flags token-like keys in the working-directory config', async () => {
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.json'),
    JSON.stringify({ default_profile: 'client-a', token: 'oops' }),
  )

  const payload = expectSuccess(
    run(['doctor', '--json'], isolation(), { cwd: workDir }),
    'doctor',
  )
  assert.equal(payload.data.config.project.code, 'token_store_unsafe')
  assert.ok(payload.data.config.project.hint.includes('token'))
  assert.equal(payload.data.next_command, 'npx --yes @artifactshare/cli login')
})
