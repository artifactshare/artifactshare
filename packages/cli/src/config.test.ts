import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  rootBypassesFilePermissions,
  run,
} from './test/helpers.js'

test('config set/get/unset preserves user config and resolves defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'artifactshare-config-home-'))
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-work-'))
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      default_profile: 'default',
      profiles: { default: { email: 'user@example.com' } },
      custom: true,
    }),
  )
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: home,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }
  const set = expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'user',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config set',
  )
  assert.equal(set.data.default_artifact_visibility.source, 'user')
  const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  assert.equal(stored.default_profile, 'default')
  assert.deepEqual(stored.profiles.default, { email: 'user@example.com' })
  assert.equal(stored.custom, true)
  const get = expectSuccess(
    run(['config', 'get', 'default_project_visibility', '--json'], env, {
      cwd: work,
    }),
    'config get',
  )
  assert.deepEqual(get.data.default_project_visibility, {
    value: 'workspace',
    source: 'product_default',
  })
  const unset = expectSuccess(
    run(
      [
        'config',
        'unset',
        'default_artifact_visibility',
        '--scope',
        'user',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config unset',
  )
  assert.equal(unset.data.default_artifact_visibility.source, 'product_default')
})

test('config repository reads shared config independently of local config', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-work-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  await writeFile(
    join(work, '.artifactshare', 'config.json'),
    JSON.stringify({
      default_artifact_visibility: 'private',
      default_profile: 'shared-profile',
      keep: 'yes',
    }),
  )
  await writeFile(
    join(work, '.artifactshare', 'config.local.json'),
    JSON.stringify({
      default_profile: 'local-profile',
      default_project_id: 'project-1',
    }),
  )
  const payload = expectSuccess(
    run(
      [
        'config',
        'get',
        'default_artifact_visibility',
        '--scope',
        'repository',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    'config get',
  )
  assert.deepEqual(payload.data.default_artifact_visibility, {
    value: 'private',
    source: 'repository',
  })
  const invalid = expectFailure(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'project',
        '--scope',
        'repository',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    { command: 'config set', code: 'validation_failed' },
  )
  assert.match(invalid.error.hint, /workspace|private/)
})

test('config repository mutations preserve unrelated keys and missing unset succeeds', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-repository-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  const configPath = join(work, '.artifactshare', 'config.json')
  const original = {
    default_profile: 'repo-profile',
    default_project_id: 'prj-existing',
    default_project_visibility: 'private',
    keep: { owner: 'test' },
  }
  await writeFile(configPath, `${JSON.stringify(original)}\n`)
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }

  expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'repository',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config set',
  )
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    ...original,
    home_audience: 'private',
  })

  const unset = expectSuccess(
    run(
      [
        'config',
        'unset',
        'default_project_visibility',
        '--scope',
        'repository',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config unset',
  )
  assert.deepEqual(unset.data.default_project_visibility, {
    value: 'workspace',
    source: 'product_default',
  })
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    default_profile: 'repo-profile',
    default_project_id: 'prj-existing',
    home_audience: 'private',
    keep: { owner: 'test' },
  })
})

test('config get reports null for individual scopes and repository over user over product default', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-effective-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({ default_artifact_visibility: 'private' }),
  )
  await writeFile(
    join(work, '.artifactshare/config.json'),
    JSON.stringify({ default_artifact_visibility: 'workspace' }),
  )
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }

  const repository = expectSuccess(
    run(
      [
        'config',
        'get',
        'default_artifact_visibility',
        '--scope',
        'repository',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config get',
  )
  assert.deepEqual(repository.data.default_artifact_visibility, {
    value: 'workspace',
    source: 'repository',
  })
  const user = expectSuccess(
    run(
      [
        'config',
        'get',
        'default_project_visibility',
        '--scope',
        'user',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config get',
  )
  assert.deepEqual(user.data.default_project_visibility, {
    value: null,
    source: 'user',
  })
  const effective = expectSuccess(
    run(['config', 'get', '--json'], env, { cwd: work }),
    'config get',
  )
  assert.deepEqual(effective.data, {
    home_audience: { value: 'workspace', source: 'repository' },
  })
})

test('config rejects invalid input without changing the file and parent config fails with JSON contract', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-invalid-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  const configPath = join(work, '.artifactshare/config.json')
  await writeFile(configPath, '{"keep":true}\n')
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }
  const before = await readFile(configPath, 'utf8')

  const invalidCases: Array<[string[], RegExp]> = [
    [
      [
        'config',
        'set',
        'unknown',
        'private',
        '--scope',
        'repository',
        '--json',
      ],
      /default_artifact_visibility|default_project_visibility/,
    ],
    [
      [
        'config',
        'set',
        'default_artifact_visibility',
        'public',
        '--scope',
        'repository',
        '--json',
      ],
      /workspace|private/,
    ],
    [
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'workspace',
        '--json',
      ],
      /repository|user/,
    ],
  ]
  for (const [args, hintPattern] of invalidCases) {
    const failure = expectFailure(run(args, env, { cwd: work }), {
      command: 'config set',
      code: 'validation_failed',
    })
    assert.match(failure.error.hint, hintPattern)
    assert.equal(await readFile(configPath, 'utf8'), before)
  }

  const parent = expectFailure(run(['config', '--json'], env, { cwd: work }), {
    command: 'config',
  })
  assert.match(
    parent.error.message,
    /subcommand|config get|config set|config unset/i,
  )
})

test('config rejects invalid stored visibility instead of falling back to workspace', async () => {
  const work = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-invalid-value-'),
  )
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-invalid-value-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  await writeFile(
    join(work, '.artifactshare/config.json'),
    JSON.stringify({ default_artifact_visibility: 'privte' }),
  )

  for (const scope of ['repository', 'effective']) {
    const failure = expectFailure(
      run(['config', 'get', '--scope', scope, '--json'], {}, { cwd: work }),
      { command: 'config get', code: 'validation_failed' },
    )
    assert.match(failure.error.message, /workspace or private/)
  }

  expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'repository',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    'config set',
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(work, '.artifactshare/config.json'), 'utf8'),
    ),
    { home_audience: 'private' },
  )

  await writeFile(
    join(work, '.artifactshare/config.json'),
    JSON.stringify({ default_artifact_visibility: 'bad-repository' }),
  )
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({ default_artifact_visibility: 'bad-user' }),
  )
  expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'workspace',
        '--scope',
        'repository',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    'config set',
  )
  expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'user',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    'config set',
  )
})

test('config accepts a value flag before the subcommand', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  const home = run(['--scope', 'effective', 'config', 'get', '--json'], {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })
  const payload = expectSuccess(home, 'config get')
  assert.equal(payload.data.home_audience.source, 'product_default')
})

test('config repository mutation refuses malformed JSON without changing the file', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-malformed-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-global-'),
  )
  await mkdir(join(work, '.artifactshare'))
  const configPath = join(work, '.artifactshare/config.json')
  const malformed = '{"default_profile":"keep",'
  await writeFile(configPath, malformed)

  expectFailure(
    run(['config', 'get', '--scope', 'effective', '--json'], {}, { cwd: work }),
    { command: 'config get', code: 'validation_failed' },
  )
  expectFailure(
    run(
      ['config', 'get', '--scope', 'repository', '--json'],
      {},
      { cwd: work },
    ),
    { command: 'config get', code: 'validation_failed' },
  )
  expectFailure(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'user',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    { command: 'config set', code: 'validation_failed' },
  )
  await assert.rejects(readFile(join(configHome, 'config.json'), 'utf8'), {
    code: 'ENOENT',
  })

  const failure = expectFailure(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'repository',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      { cwd: work },
    ),
    { command: 'config set', code: 'validation_failed' },
  )

  assert.match(failure.error.message, /invalid JSON/)
  assert.equal(await readFile(configPath, 'utf8'), malformed)
})

test('config user mutation refuses malformed JSON without changing the file', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-malformed-global-'),
  )
  const configPath = join(configHome, 'config.json')
  const malformed = '{"default_profile":"keep",'
  await writeFile(configPath, malformed)

  expectFailure(
    run(['config', 'get', '--scope', 'effective', '--json'], {
      ARTIFACTSHARE_CONFIG_HOME: configHome,
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    }),
    { command: 'config get', code: 'validation_failed' },
  )
  expectFailure(
    run(['config', 'get', '--scope', 'user', '--json'], {
      ARTIFACTSHARE_CONFIG_HOME: configHome,
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    }),
    { command: 'config get', code: 'validation_failed' },
  )

  const failure = expectFailure(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'private',
        '--scope',
        'user',
        '--json',
      ],
      {
        ARTIFACTSHARE_CONFIG_HOME: configHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
    ),
    { command: 'config set', code: 'validation_failed' },
  )

  assert.match(failure.error.message, /invalid JSON/)
  assert.equal(await readFile(configPath, 'utf8'), malformed)
})

test.skipIf(rootBypassesFilePermissions)(
  'config user mutation reports write failures with its command contract',
  async () => {
    const configHome = await mkdtemp(
      join(tmpdir(), 'artifactshare-config-readonly-global-'),
    )
    const configPath = join(configHome, 'config.json')
    const original = JSON.stringify({ default_profile: 'keep' })
    await writeFile(configPath, original)
    await chmod(configPath, 0o400)

    try {
      const failure = expectFailure(
        run(
          [
            'config',
            'set',
            'default_artifact_visibility',
            'private',
            '--scope',
            'user',
            '--json',
          ],
          {
            ARTIFACTSHARE_CONFIG_HOME: configHome,
            ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
          },
        ),
        { command: 'config set', code: 'validation_failed' },
      )

      assert.match(failure.error.message, /could not be written/)
      assert.equal(await readFile(configPath, 'utf8'), original)
    } finally {
      await chmod(configPath, 0o600)
    }
  },
)

test('config home audience normalizes aliases and preserves project visibility', async () => {
  const work = await mkdtemp(join(tmpdir(), 'artifactshare-config-home-alias-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-home-alias-user-'),
  )
  await mkdir(join(work, '.artifactshare'))
  const configPath = join(work, '.artifactshare/config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      default_artifact_visibility: 'private',
      default_project_visibility: 'workspace',
      keep: true,
    }),
  )
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }

  const omitted = expectSuccess(
    run(['config', 'get', '--json'], env, { cwd: work }),
    'config get',
  )
  assert.deepEqual(omitted.data, {
    home_audience: { value: 'private', source: 'repository' },
  })

  const set = expectSuccess(
    run(
      [
        'config',
        'set',
        'default_artifact_visibility',
        'workspace',
        '--scope',
        'repository',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config set',
  )
  assert.equal(set.data.default_artifact_visibility.value, 'workspace')
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    default_project_visibility: 'workspace',
    keep: true,
    home_audience: 'workspace',
  })

  expectSuccess(
    run(
      ['config', 'unset', 'home_audience', '--scope', 'repository', '--json'],
      env,
      { cwd: work },
    ),
    'config unset',
  )
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    default_project_visibility: 'workspace',
    keep: true,
  })
})

test('config home audience repairs target invalid values but refuses invalid effective lower scope', async () => {
  const work = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-home-repair-'),
  )
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-config-home-repair-user-'),
  )
  await mkdir(join(work, '.artifactshare'))
  const configPath = join(work, '.artifactshare/config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      home_audience: 'broken',
      default_artifact_visibility: 'private',
    }),
  )
  const env = {
    ARTIFACTSHARE_CONFIG_HOME: configHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }
  expectSuccess(
    run(
      [
        'config',
        'set',
        'home_audience',
        'workspace',
        '--scope',
        'repository',
        '--json',
      ],
      env,
      { cwd: work },
    ),
    'config set',
  )
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    home_audience: 'workspace',
  })

  await writeFile(
    configPath,
    JSON.stringify({ default_artifact_visibility: 'broken' }),
  )
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({ home_audience: 'broken-user' }),
  )
  const before = await readFile(configPath, 'utf8')
  expectFailure(
    run(
      ['config', 'unset', 'home_audience', '--scope', 'repository', '--json'],
      env,
      { cwd: work },
    ),
    { command: 'config unset', code: 'validation_failed' },
  )
  assert.equal(await readFile(configPath, 'utf8'), before)
})
