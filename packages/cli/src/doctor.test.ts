import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('whoami --base-url with empty inline value fails with validation_failed', () => {
  const result = run(['whoami', '--base-url=', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  expectFailure(result, { command: 'whoami', code: 'validation_failed' })
})

test('doctor ignores share-only flags instead of adding invalid destination data', () => {
  const result = run(['doctor', '--project-id', 'proj_123', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  const payload = expectSuccess(result, 'doctor')
  assert.equal(payload.data.destination.ok, true)
})

test('doctor --json reports missing destination without failing', () => {
  const result = run(['doctor', '--json'], { ARTIFACTSHARE_TOKEN: '' })

  const payload = expectSuccess(result, 'doctor')
  assert.equal(payload.data.destination.ok, true)
  assert.equal(payload.data.auth.token_present, false)
  assert.equal(payload.data.auth.credential_source, 'none')
  assert.equal(payload.data.auth.code, 'auth_required')
  assert.equal(payload.data.next_command, 'npx --yes @artifactshare/cli login')
  assert.deepEqual(payload.data.auth.recovery, {
    login_command: 'npx --yes @artifactshare/cli login',
    token_url: 'https://artifactshare.com/settings/tokens',
    env_var: 'ARTIFACTSHARE_TOKEN',
    token_option: '--token',
  })
})

test('doctor --json reports a selected profile without reading a token', () => {
  const result = run(['doctor', '--profile', 'client-a', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  const payload = expectSuccess(result, 'doctor')
  assert.equal(payload.data.auth.token_present, false)
  assert.equal(payload.data.auth.credential_source, 'profile')
  assert.equal(payload.data.auth.profile, 'client-a')
  assert.equal(payload.data.auth.code, 'auth_required')
  assert.equal(
    payload.data.next_command,
    'npx --yes @artifactshare/cli login --profile client-a',
  )
  assert.deepEqual(payload.data.auth.recovery, {
    login_command: 'npx --yes @artifactshare/cli login --profile client-a',
    token_url: 'https://artifactshare.com/settings/tokens',
    env_var: 'ARTIFACTSHARE_TOKEN',
    token_option: '--token',
  })
})

test('doctor next_command is null when all checks pass', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          auth: { ok: true },
          user: { email: 'person@example.com' },
          upload: { ok: true },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['doctor', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'doctor')
      assert.equal(payload.data.auth.ok, true)
      assert.equal(payload.data.upload.ok, true)
      assert.equal(payload.data.next_command, null)
    },
  )
})

test('doctor warns when an agent profile default is outside its approved project', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'artifactshare-doctor-scope-'))
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-doctor-home-'))
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.local.json'),
    JSON.stringify({ default_project_id: 'prj-old' }),
  )

  try {
    await withServer(
      (_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            auth: {
              ok: true,
              authority: { preset: 'agent', project_id: 'prj-agent' },
            },
            user: { email: 'person@example.com' },
            upload: { ok: true },
          }),
        )
      },
      async (baseUrl) => {
        await writeFile(
          join(configHome, 'config.json'),
          JSON.stringify({
            profiles: {
              agent: { base_url: baseUrl, preset: 'agent' },
            },
          }),
        )
        await writeFile(
          join(configHome, 'tokens.json'),
          JSON.stringify({
            [`${baseUrl}:agent`]: JSON.stringify({
              kind: 'api_token',
              token: 'test-token',
            }),
          }),
        )

        const result = await runAsync(
          [
            'doctor',
            '--profile',
            'agent',
            '--allow-plaintext-token-store',
            '--json',
          ],
          {
            ARTIFACTSHARE_CONFIG_HOME: configHome,
            ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
          },
          { cwd: workDir },
        )
        const payload = expectSuccess(result, 'doctor')
        assert.equal(
          payload.data.destination.code,
          'agent_scope_mismatch',
          JSON.stringify(payload.data),
        )
        assert.equal(payload.data.destination.project_id, 'prj-old')
        assert.equal(payload.data.destination.approved_project_id, 'prj-agent')
        assert.match(payload.data.destination.hint, /prj-old|approved project/)
        assert.equal(
          payload.data.next_command,
          'npx --yes @artifactshare/cli init --profile agent --project-id prj-agent --json',
        )
      },
    )
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await rm(configHome, { recursive: true, force: true })
  }
})

test('doctor reports blocked upload without a next_command', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          auth: { ok: true },
          user: { email: 'person@example.com' },
          upload: { ok: false, code: 'upload-not-allowed' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['doctor', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'doctor')
      assert.equal(payload.data.upload.ok, false)
      assert.equal(payload.data.upload.code, 'upload-not-allowed')
      assert.equal(payload.data.next_command, null)
    },
  )
})

test('doctor next_command points at login for token_store_unsafe', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-doctor-'))
  await mkdir(join(workDir, '.artifactshare'))
  await writeFile(
    join(workDir, '.artifactshare/config.json'),
    JSON.stringify({ token: 'oops' }),
  )

  const result = run(
    ['doctor', '--json'],
    {
      ARTIFACTSHARE_TOKEN: '',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
    { cwd: workDir },
  )

  const payload = expectSuccess(result, 'doctor')
  assert.equal(payload.data.config.project.code, 'token_store_unsafe')
  assert.equal(payload.data.next_command, 'npx --yes @artifactshare/cli login')
})

test('doctor reports outdated managed skills with update commands', async () => {
  const workDir = await mkdtemp(
    join(tmpdir(), 'artifactshare-cli-doctor-work-'),
  )
  const homeDir = await mkdtemp(
    join(tmpdir(), 'artifactshare-cli-doctor-home-'),
  )
  const env = {
    HOME: homeDir,
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  }
  try {
    expectSuccess(
      run(['skills', 'install', '--tool', 'codex', '--json'], env, {
        cwd: workDir,
      }),
      'skills install',
    )
    const skillPath = join(
      workDir,
      '.agents',
      'skills',
      'artifactshare',
      'SKILL.md',
    )
    const installed = await readFile(skillPath, 'utf8')
    await writeFile(skillPath, installed.replace(/version: \d+/, 'version: 0'))

    const payload = expectSuccess(
      run(['doctor', '--json'], env, { cwd: workDir }),
      'doctor',
    )
    assert.equal(payload.data.skills.update_available, true)
    assert.equal(
      payload.data.skills.update_command,
      'npx --yes @artifactshare/cli skills update --json',
    )
    const codexProject = payload.data.skills.targets.find(
      (target: any) => target.tool === 'codex' && target.scope === 'project',
    )
    assert.equal(codexProject.update_available, true)
    assert.equal(
      codexProject.update_command,
      'npx --yes @artifactshare/cli skills update --tool codex --scope project --json',
    )
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('doctor next_command is null when network fails', () => {
  const result = run(
    ['doctor', '--home', '--base-url', 'http://127.0.0.1:1', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectSuccess(result, 'doctor')
  assert.equal(payload.data.network.ok, false)
  assert.equal(payload.data.next_command, null)
})

test('doctor next_command is null when the API returns 500', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 500
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'internal-error', message: 'Server error.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['doctor', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'doctor')
      assert.equal(payload.data.auth.ok, false)
      assert.equal(payload.data.auth.code, 'service_error')
      assert.equal(payload.data.next_command, null)
    },
  )
})

test('doctor next_command is null when ARTIFACTSHARE_TOKEN is rejected', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'invalid-token', message: 'Invalid token.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['doctor', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'doctor')
      assert.equal(payload.data.auth.ok, false)
      assert.equal(payload.data.auth.code, 'token_invalid')
      assert.equal(payload.data.auth.credential_source, 'env')
      assert.equal(payload.data.next_command, null)
      assert.equal(payload.data.auth.recovery, undefined)
    },
  )
})

test('doctor points at profile login when saved profile token is rejected', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-doctor-auth-'))

  await withServer(
    (_request, response) => {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'invalid-token', message: 'Invalid token.' },
        }),
      )
    },
    async (baseUrl) => {
      await writeFile(
        join(configHome, 'tokens.json'),
        `${JSON.stringify({ [`${baseUrl}:expired`]: 'expired-token' })}\n`,
      )

      const result = await runAsync(
        [
          'doctor',
          '--home',
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        {
          ARTIFACTSHARE_TOKEN: '',
          ARTIFACTSHARE_CONFIG_HOME: configHome,
          ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        },
      )

      const payload = expectSuccess(result, 'doctor')
      assert.equal(payload.data.auth.ok, false)
      assert.equal(payload.data.auth.code, 'auth_required')
      assert.equal(payload.data.auth.credential_source, 'profile')
      assert.equal(payload.data.auth.profile, 'expired')
      assert.equal(
        payload.data.next_command,
        'npx --yes @artifactshare/cli login --profile expired',
      )
      assert.deepEqual(payload.data.auth.recovery, {
        login_command: 'npx --yes @artifactshare/cli login --profile expired',
        token_url: `${baseUrl}/settings/tokens`,
        env_var: 'ARTIFACTSHARE_TOKEN',
        token_option: '--token',
      })
    },
  )
})
