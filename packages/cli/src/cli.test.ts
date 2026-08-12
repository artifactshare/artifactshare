import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { apiUrl } from './api.js'
import {
  expectFailure,
  recordCliSubprocessLaunch,
  run,
} from './test/helpers.js'

test('--version prints package.json version', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const result = run(['--version'])

  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes(pkg.version))
})

test('--version works when launched via symlink (bin entrypoint)', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const distIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const tempDir = await mkdtemp(join(tmpdir(), 'artifactshare-cli-bin-'))
  const symlinkPath = join(tempDir, 'artifactshare')
  try {
    symlinkSync(distIndex, symlinkPath)
    recordCliSubprocessLaunch()
    const result = spawnSync(process.execPath, [symlinkPath, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0)
    assert.ok(result.stdout.includes(pkg.version))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('--help prints the top-level command list', () => {
  const result = run(['--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Artifact Share CLI/)
  assert.match(result.stdout, /share <path>/)
  assert.match(result.stdout, /update <artifact-id-or-url> <path>/)
  assert.match(result.stdout, /logout/)
  assert.match(result.stdout, /Authentication:/)
  assert.match(result.stdout, /Agent with a user present:.*--preset agent/s)
  assert.match(result.stdout, /Unattended CI or scripts:/)
  assert.match(result.stdout, /ARTIFACTSHARE_TOKEN/)
  assert.match(result.stdout, /--token/)
  assert.match(result.stdout, /https:\/\/artifactshare\.com\/settings\/tokens/)
  assert.match(result.stdout, /Common failures:/)
  assert.match(result.stdout, /config get/)
})

test('login --help prefers restricted login for attended agents', () => {
  const result = run(['login', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /browser approval/)
  assert.match(result.stdout, /interactive terminal/)
  assert.match(result.stdout, /agent with a user present.*--preset agent/is)
  assert.match(result.stdout, /approve one project/)
  assert.match(result.stdout, /unattended CI or scripts/)
  assert.match(result.stdout, /ARTIFACTSHARE_TOKEN/)
  assert.match(result.stdout, /--token/)
  assert.match(result.stdout, /do not pass the token to login/)
  assert.match(result.stdout, /https:\/\/artifactshare\.com\/settings\/tokens/)
  assert.doesNotMatch(result.stdout, /For agents or CI, issue a token/)
})

test('auth guidance does not direct attended agents to API tokens', () => {
  const result = run(['resolve', 'example'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /for an agent, add --preset agent/i)
  assert.match(result.stderr, /unattended CI or scripts/i)
  assert.doesNotMatch(result.stderr, /In agents or CI, issue a token/)
})

test('config --help explains purpose-based home audience guidance', () => {
  const result = run(['config', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Personal safe default.*--scope user/s)
  assert.match(
    result.stdout,
    /Shared policy agreed by all repository participants/,
  )
  assert.match(result.stdout, /One-time audience.*--visibility/)
  assert.match(result.stdout, /--scope effective/)
  assert.match(result.stdout, /home_audience/)
  assert.match(
    result.stdout,
    /default_artifact_visibility.*Compatibility alias/,
  )
  assert.match(result.stdout, /default_project_visibility.*Advanced default/)
  assert.match(
    result.stdout,
    /Keyless config get --json returns only home_audience/,
  )
  assert.match(
    result.stdout,
    /Project defaults resolve repository, user, then workspace/,
  )
})

test('--insecure-localhost is limited to local HTTPS base URLs', () => {
  const result = run(
    [
      'whoami',
      '--base-url',
      'https://artifactshare.com',
      '--insecure-localhost',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, {
    command: 'whoami',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /local HTTPS/)
})

test('--profile and ARTIFACTSHARE_TOKEN fail with stable JSON', () => {
  const result = run(['whoami', '--profile', 'client-a', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  const payload = expectFailure(result, {
    command: 'whoami',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /--profile/)
})

test('--insecure-localhost keeps JSON parseable for local TLS failures', () => {
  const result = run(
    [
      'whoami',
      '--base-url',
      'https://localhost:9',
      '--insecure-localhost',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  assert.doesNotMatch(result.stderr, /NODE_TLS_REJECT_UNAUTHORIZED/)
  expectFailure(result, { command: 'whoami', code: 'network_failed' })
})

test('global options can appear before the command', () => {
  const result = run(
    [
      '--base-url',
      'https://example.test',
      'share',
      'sample.html',
      '--home',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, { command: 'share' })
  assert.match(
    payload.error.code,
    /network_failed|service_error|validation_failed/,
  )
})

test('parse validation failures respect --json in argv', () => {
  const result = run(['share', '--json', '--json=true', '--home'])

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('parse validation failures respect CI json mode without --json', () => {
  const result = run(['share', '--json=true', '--home'], { CI: 'true' })

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('old publish and agent open commands are not aliases', () => {
  for (const args of [
    ['publish', 'sample.html', '--home', '--json'],
    ['agent', 'open', 'https://artifactshare.com/a/abc123def4', '--json'],
  ]) {
    const payload = expectFailure(run(args), {
      command: 'unknown',
      code: 'unknown_command',
    })
    assert.match(payload.error.hint, /Run npx --yes @artifactshare\/cli --help/)
  }
})

test('apiUrl preserves a path-prefixed base URL', () => {
  assert.equal(
    apiUrl('/api/cli/whoami', 'https://example.test/artifactshare').href,
    'https://example.test/artifactshare/api/cli/whoami',
  )
})

test('bare parent commands fail with validation_failed instead of silent success', () => {
  for (const parent of ['artifacts', 'comments', 'profiles', 'projects']) {
    const payload = expectFailure(run([parent, '--json']), {
      command: parent,
      code: 'validation_failed',
    })
    assert.match(payload.error.hint, new RegExp(parent))
  }
})
