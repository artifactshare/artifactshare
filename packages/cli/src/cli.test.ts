import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  ) as {
    version: string
  }
  const result = run(['--version'])

  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes(pkg.version))
})

test('package exposes an npm-inferable cli bin alongside named entrypoints', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    bin: Record<string, string>
  }

  assert.equal(pkg.bin.cli, './dist/index.js')
  assert.equal(pkg.bin.artifactshare, pkg.bin.cli)
  assert.equal(
    pkg.bin['artifactshare-preview-cursor'],
    './dist/cursor-acp-entry.js',
  )
})

test('--version works when launched via symlink (bin entrypoint)', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string
  }
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
  assert.match(result.stdout, /Attended local agent:.*--preset agent/s)
  assert.match(result.stdout, /shared agent platforms.*model sandbox/i)
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
  assert.match(
    result.stdout,
    /attended agent on your machine.*--preset agent/is,
  )
  assert.match(result.stdout, /--project.*fixed project/is)
  assert.match(result.stdout, /shared agent platform.*model sandbox/is)
  assert.match(result.stdout, /ARTIFACTSHARE_TOKEN/)
  assert.match(result.stdout, /--token/)
  assert.match(result.stdout, /do not pass tokens to login/i)
  assert.match(result.stdout, /https:\/\/artifactshare\.com\/settings\/tokens/)
  assert.doesNotMatch(result.stdout, /For agents or CI, issue a token/)
})

test('auth guidance does not direct attended agents to API tokens', () => {
  const result = run(['resolve', 'example', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /attended local agent.*--preset agent/i)
  assert.match(result.stderr, /shared agent platforms.*model sandbox/i)
  assert.doesNotMatch(result.stderr, /In agents or CI, issue a token/)
  const payload = JSON.parse(result.stderr) as {
    error: { details: { agent_login_command: string } }
  }
  assert.equal(
    payload.error.details.agent_login_command,
    'npm exec --yes --package=@artifactshare/cli -- artifactshare login --profile default --preset agent',
  )
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
    assert.match(
      payload.error.hint,
      /Run npm exec --yes --package=@artifactshare\/cli -- artifactshare --help/,
    )
  }
})

test('apiUrl preserves a path-prefixed base URL', () => {
  assert.equal(
    apiUrl('/api/cli/whoami', 'https://example.test/artifactshare').href,
    'https://example.test/artifactshare/api/cli/whoami',
  )
})

test('apiUrl keeps bounded comment query parameters separate from the pathname', () => {
  const params = new URLSearchParams({
    thread_id: 'thr1',
    before: 'cursor+/=',
    limit: '50',
  })
  const url = apiUrl(
    `/api/cli/artifacts/abc123def4/comments?${params}`,
    'https://example.com/prefix?discard=true#fragment',
  )
  assert.equal(url.pathname, '/prefix/api/cli/artifacts/abc123def4/comments')
  assert.deepEqual(
    Object.fromEntries(url.searchParams),
    Object.fromEntries(params),
  )
  assert.equal(url.hash, '')
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

test('artifacts help advertises the deletion alias', () => {
  const result = run(['artifacts', '--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /delete <OPTIONS>\s+Permanently delete/)
  assert.match(result.stdout, /alias of top-level delete/)
})

test('label is an update-only option and empty values fail before authentication', () => {
  assert.match(run(['update', '--help']).stdout, /--label/)
  for (const command of ['share', 'append', 'preview'])
    assert.doesNotMatch(run([command, '--help']).stdout, /--label/)
  for (const args of [['--label='], ['--label', ''], ['--label', '--json']]) {
    expectFailure(
      run(['update', 'abc123def4', 'missing.html', '--json', ...args]),
      { command: 'update', code: 'validation_failed' },
    )
  }
})

test('edit help documents project visibility and its placement requirement', () => {
  const result = run(['edit', '--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /private, workspace, project, or link/)
  assert.match(result.stdout, /project requires placement in a project/)
})

for (const command of ['share', 'update']) {
  test(`${command} help explains upload boundary recovery`, () => {
    const result = run([command, '--help'])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /upload_read_failed.*permissions, then retry/)
    assert.match(
      result.stdout,
      /link\s+Copy into the selection or pass the target by absolute path/,
    )
    assert.match(result.stdout, /outside_cwd\s+Pass an absolute path/)
    assert.match(
      result.stdout,
      /parent_traversal\s+Pass a direct absolute path without any \.\. component/,
    )
    assert.match(
      result.stdout,
      /changed\s+The selection changed while reading; retry/,
    )
  })
}

for (const command of ['share', 'append']) {
  test(`${command} help describes upload boundary recovery`, () => {
    const result = run([command, '--help'])
    assert.equal(result.status, 0)
    for (const reason of [
      'upload_read_failed',
      'validation_failed',
      'link',
      'outside_cwd',
      'parent_traversal',
      'changed',
      'not_found',
      'invalid_type',
      'unsupported_guarantee',
    ]) {
      assert.ok(result.stdout.includes(reason), reason)
    }
  })
}

test('unknown options fail at root, parent, nested and implicit commands', () => {
  for (const [args, command] of [
    [['--bogus-flag', 'x'], 'unknown'],
    [['whoami', '--bogus-flag', 'x'], 'whoami'],
    [['changelog', '--visibility', 'private'], 'changelog'],
    [['profiles', 'import-token', '--token', 'x'], 'profiles import-token'],
    [['share', 'test.md', '--visiblity', 'private'], 'share'],
    [['artifacts', '--bogus'], 'artifacts'],
    [
      ['artifacts', 'get', 'abc123def4', '--visibility', 'private'],
      'artifacts get',
    ],
    [['preview', 'test.md', '--bogus'], 'preview start'],
    [['config', 'set', 'home_audience', 'private', '--bogus'], 'config set'],
    [['skills', 'install', '--tool', 'codex', '--bogus'], 'skills install'],
    [['whoami', '--help', '--bogus'], 'whoami'],
    [['--version', '--bogus'], 'unknown'],
    [['whoami', '-x'], 'whoami'],
  ] as Array<[string[], string]>) {
    const result = run([...args, '--json'])
    const { error } = expectFailure(result, { command, code: 'unknown_option' })
    assert.equal(result.stdout, '')
    assert.equal(error.agent_recoverable, true)
    assert.equal(error.requires_human, false)
    assert.equal(error.recovery.kind, 'change_input')
    assert.ok(error.details.option.startsWith('-'))
  }
})

test('globals, camelCase, equals and short help remain accepted', () => {
  for (const args of [
    ['--profile', 'work', 'whoami', '-h'],
    ['--baseUrl=https://example.test', 'artifacts', '--json', 'get', '-h'],
    [
      'share',
      '--noSlackNotify',
      '--expectedVersion=v1',
      '--visibility=private',
      '--help',
    ],
    ['preview', 'report.md', '--profile=work', '--help'],
    ['-v'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.notEqual(result.stdout, '')
  }
})

test('invalid inputs leave configuration and managed skills unchanged without fetching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-invalid-input-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const skillDir = join(home, '.codex', 'skills', 'artifactshare')
  const skill = join(skillDir, 'SKILL.md')
  const original =
    '<!-- artifactshare-skill\nversion: 1\nmanaged: true\n-->\nOld managed instructions\n'
  try {
    await mkdir(skillDir, { recursive: true })
    await mkdir(config)
    await writeFile(skill, original)
    const preload = join(root, 'no-fetch.mjs')
    const fetched = join(root, 'fetched')
    await writeFile(
      preload,
      `import { writeFileSync } from 'node:fs'; import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { if (specifier === 'undici') { writeFileSync(${JSON.stringify(fetched)}, 'called'); throw new Error('Unexpected HTTP dependency load'); } return next(specifier, context); } });`,
    )
    for (const args of [
      ['whoami', '--bogus-flag', 'x'],
      ['share', 'missing.md', '--visiblity', 'private'],
      ['config', 'set', 'home_audience', 'private', '--bogus'],
      ['skills', 'install', '--tool', 'codex', '--bogus'],
      ['share', 'missing.md', '--key', 'k', '--expected-version', '2'],
      ['update', 'abc123def4', 'missing.md', '--expectedVersion=002'],
    ]) {
      const result = run(
        [...args, '--json'],
        {
          HOME: home,
          ARTIFACTSHARE_CONFIG_HOME: config,
          ARTIFACTSHARE_TOKEN: '',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        { cwd: root },
      )
      expectFailure(result, {
        code: args.some((arg) => arg.startsWith('--expected'))
          ? 'invalid_expected_version'
          : 'unknown_option',
      })
      assert.deepEqual(await readdir(config), [])
      assert.equal(await readFile(skill, 'utf8'), original)
      assert.deepEqual((await readdir(root)).sort(), [
        'config',
        'home',
        'no-fetch.mjs',
      ])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('opaque version ids are sent unchanged with every accepted spelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-version-id-'))
  try {
    const file = join(root, 'report.md')
    const request = join(root, 'request.json')
    const preload = join(root, 'request.mjs')
    await writeFile(file, '# Report')
    const mock = `import { writeFileSync } from 'node:fs';
      export const FormData = globalThis.FormData;
      export class Agent {}
      export async function fetch(input) {
        writeFileSync(${JSON.stringify(request)}, JSON.stringify(String(input)));
        return new Response(JSON.stringify({error:{code:'version_conflict',message:'Changed'}}), {status:409});
      }`
    await writeFile(
      preload,
      `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { if (specifier === 'undici') return {url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(mock))}, shortCircuit: true}; return next(specifier, context); } });`,
    )
    for (const command of ['share', 'update']) {
      for (const option of [
        ['--expected-version', 'Ab0x9'],
        ['--expected-version=Ab0x9'],
        ['--expectedVersion', 'Ab0x9'],
        ['--expectedVersion=Ab0x9'],
      ]) {
        const args =
          command === 'share'
            ? ['share', file, '--key', 'k']
            : ['update', 'abc123def4', file]
        const result = run(
          [...args, ...option, '--json'],
          {
            ARTIFACTSHARE_TOKEN: 'test-token',
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          { cwd: root },
        )
        expectFailure(result, { command, code: 'version_conflict' })
        const url = new URL(JSON.parse(await readFile(request, 'utf8')))
        assert.equal(url.searchParams.get('expected_version'), 'Ab0x9')
        await rm(request)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('update unknown sharing options retain actionable edit guidance', () => {
  for (const option of ['--visibility', '--projectId', '--grant-email']) {
    const { error } = expectFailure(
      run(['update', 'abc123def4', 'missing.md', option, 'private', '--json']),
      { command: 'update', code: 'unknown_option' },
    )
    assert.match(error.hint, /Update only adds a new version/)
    assert.match(error.hint, /edit/)
    assert.deepEqual(error.details, { option })
  }
})

test('changelog accepts shared flags while rejecting undefined options', () => {
  const result = run([
    'changelog',
    '--profile',
    'p',
    '--base-url',
    'https://example.com',
    '--allow-plaintext-token-store',
    '--insecure-localhost',
    '--token',
    'test-token',
    '--json',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  expectFailure(run(['changelog', '--bogus', '--json']), {
    command: 'changelog',
    code: 'unknown_option',
  })
})

test('import-token rejects token options with standard-input guidance', () => {
  for (const option of [['--token', 'x'], ['--token=x']]) {
    const { error } = expectFailure(
      run(['profiles', 'import-token', ...option, '--json']),
      { command: 'profiles import-token', code: 'unknown_option' },
    )
    assert.equal(error.details.option, '--token')
    assert.equal(
      error.hint,
      'Pipe the token on standard input so it does not appear in process arguments.',
    )
    assert.equal(error.recovery.kind, 'change_input')
  }
})
