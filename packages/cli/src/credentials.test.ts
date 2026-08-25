import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { resolveCredential } from './credentials.js'

test('--token wins over ARTIFACTSHARE_TOKEN and default profiles', async () => {
  const result = await withEnv(
    { ARTIFACTSHARE_TOKEN: 'env-token' },
    async () =>
      await resolveCredential(
        { token: 'option-token' },
        { default_profile: 'project-default' },
      ),
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'token_option')
    assert.equal(result.token, 'option-token')
  }
})

test('--profile with a bearer token fails before network access', async () => {
  const result = await withEnv(
    { ARTIFACTSHARE_TOKEN: 'env-token' },
    async () => await resolveCredential({ profile: 'client-a' }),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'validation_failed')
    assert.equal(result.source, 'env')
    assert.equal(result.profile, 'client-a')
  }
})

test('project config default_profile becomes an auth_required profile source', async () => {
  const result = await withEnv(
    {
      ARTIFACTSHARE_TOKEN: '',
      ARTIFACTSHARE_CONFIG_HOME: join(tmpdir(), 'artifactshare-cli-missing'),
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
    async () =>
      await resolveCredential({}, { default_profile: 'project-default' }),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'auth_required')
    assert.equal(result.source, 'project_config')
    assert.equal(result.profile, 'project-default')
    assert.deepEqual(result.error.details, {
      token_url: 'https://artifactshare.com/settings/tokens',
      env_var: 'ARTIFACTSHARE_TOKEN',
      login_command:
        'npx --yes @artifactshare/cli login --profile project-default',
      agent_login_command:
        'npx --yes @artifactshare/cli login --profile project-default --preset agent',
      token_option: '--token',
      credential_source: 'project_config',
      profile: 'project-default',
    })
  }
})

test('project config default_profile keeps its source with a saved token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  try {
    await writeFile(
      join(root, 'tokens.json'),
      JSON.stringify({
        'https://artifactshare.com:project-default': JSON.stringify({
          kind: 'session',
          session_token: 'stored-token',
          refresh_token: 'refresh-token',
        }),
      }),
    )
    const result = await withEnv(
      {
        ARTIFACTSHARE_TOKEN: '',
        ARTIFACTSHARE_CONFIG_HOME: root,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      async () =>
        await resolveCredential({}, { default_profile: 'project-default' }),
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'project_config')
      assert.equal(result.profile, 'project-default')
      assert.equal(result.token, 'stored-token')
      assert.equal(result.profileCredentialKind, 'session')
      assert.equal(result.refreshToken, 'refresh-token')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local config default_profile uses local_config credential source', async () => {
  const result = await withEnv(
    {
      ARTIFACTSHARE_TOKEN: '',
      ARTIFACTSHARE_CONFIG_HOME: join(tmpdir(), 'artifactshare-cli-missing'),
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
    async () =>
      await resolveCredential(
        {},
        {
          config: { default_profile: 'local-default' },
          raw: { default_profile: 'local-default' },
          kind: 'local',
          path: '.artifactshare/config.local.json',
          directory: '/tmp/work',
        },
      ),
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.source, 'local_config')
    assert.equal(
      result.error.details?.login_command,
      'npx --yes @artifactshare/cli login --profile local-default',
    )
    assert.equal(
      result.error.details?.agent_login_command,
      'npx --yes @artifactshare/cli login --profile local-default --preset agent',
    )
    assert.equal(
      result.error.details?.token_url,
      'https://artifactshare.com/settings/tokens',
    )
    assert.equal(result.error.details?.env_var, 'ARTIFACTSHARE_TOKEN')
    assert.equal(result.error.details?.token_option, '--token')
    assert.equal(result.error.details?.credential_source, 'local_config')
    assert.equal(
      result.error.details?.config_path,
      '.artifactshare/config.local.json',
    )
    assert.equal(result.error.details?.config_kind, 'local')
  }
})

test('legacy raw profile tokens require login again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  try {
    await writeFile(
      join(root, 'tokens.json'),
      JSON.stringify({
        'https://artifactshare.com:legacy': 'raw-token',
      }),
    )
    const result = await withEnv(
      {
        ARTIFACTSHARE_TOKEN: '',
        ARTIFACTSHARE_CONFIG_HOME: root,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      async () => await resolveCredential({ profile: 'legacy' }),
    )

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'auth_required')
      assert.match(result.error.why, /old format/)
      assert.equal(result.profile, 'legacy')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('global default_profile is read from the user config directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  try {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({ default_profile: 'global-default' }),
    )
    const result = await withEnv(
      {
        ARTIFACTSHARE_TOKEN: '',
        ARTIFACTSHARE_CONFIG_HOME: root,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      async () => await resolveCredential({}),
    )

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'auth_required')
      assert.equal(result.source, 'global_profile')
      assert.equal(result.profile, 'global-default')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('auth_required suggests another profile with a saved token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  try {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        default_profile: 'stale',
        profiles: {
          stale: { base_url: 'http://127.0.0.1:8787' },
          production: { base_url: 'https://example.com' },
        },
      }),
    )
    await writeFile(
      join(root, 'tokens.json'),
      JSON.stringify({
        'https://example.com:production': JSON.stringify({
          kind: 'api_token',
          token: 'tok-prod',
        }),
      }),
    )
    const result = await withEnv(
      {
        ARTIFACTSHARE_TOKEN: '',
        ARTIFACTSHARE_CONFIG_HOME: root,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      },
      async () =>
        await resolveCredential(
          {},
          {
            config: { default_profile: 'stale' },
            raw: { default_profile: 'stale' },
            kind: 'local',
            path: '.artifactshare/config.local.json',
            directory: '/tmp/work',
          },
        ),
    )

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.agent_recoverable, true)
      assert.equal(result.error.requires_human, false)
      assert.equal(result.error.details?.alternative_profile, 'production')
      assert.deepEqual(result.error.recovery, {
        kind: 'run_command',
        command: 'npx --yes @artifactshare/cli profiles use production',
      })
      assert.equal(
        result.error.details?.suggested_profile_command,
        'npx --yes @artifactshare/cli profiles use production',
      )
      assert.ok(result.error.hint.includes('--profile production'))
      assert.ok(result.error.hint.includes('init --profile production'))
      assert.ok(result.error.hint.includes('profiles use production'))
      assert.ok(
        result.error.hint.includes('saved authorization preset is reused'),
      )
      assert.ok(!result.error.hint.includes('--profile stale --preset agent'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function withEnv<T>(
  env: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key])
    process.env[key] = env[key]
  }
  try {
    return await callback()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
