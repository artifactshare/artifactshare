import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  readdir,
  stat,
  access,
  lstat,
  readlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  plan,
  localOrigin,
  outputPath,
  repository,
  skillVersion,
  fingerprint,
} from './lib/skill-eval/plan.mjs'
import {
  temporary,
  overlay,
  createRun,
  environments,
  inventory,
  observe,
} from './lib/skill-eval/environment.mjs'
import { guardedArguments, redact } from './lib/skill-eval/launcher.mjs'
import { parseStream, score, markdown } from './lib/skill-eval/records.mjs'
import { runProcess, turnBudget } from './lib/skill-eval/process.mjs'
import { localRequest, signIn } from './lib/skill-eval/server.mjs'
import {
  loadBoundaryManifest,
  inspectTree,
} from './public-development-guard.mjs'
const exec = promisify(execFile)
test('Cursor groups completed tools by assistant step and enforces the budget', () => {
  const events = [
    { type: 'assistant', message: { content: 'Inspect' } },
    { type: 'tool_call', subtype: 'started', call_id: 'one' },
    {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'one',
      tool_call: { readToolCall: { args: { path: 'report.html' } } },
    },
    {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'two',
      tool_call: { editToolCall: {} },
    },
    { type: 'assistant', message: { content: 'Update' } },
    {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'three',
      tool_call: { editToolCall: {} },
    },
    { type: 'result', is_error: false },
  ]
  const lines = events.map((event) => JSON.stringify(event))
  assert.equal(parseStream('cursor', lines.slice(0, 4).join('\n')).turns, 1)
  assert.equal(parseStream('cursor', lines.join('\n')).turns, 2)
  assert.equal(turnBudget('cursor', 1).push(lines.join('\n') + '\n'), true)
  assert.equal(turnBudget('cursor', 2).push(lines.join('\n') + '\n'), false)
})

test('Cursor counts thinking-only and tool-only steps without splitting parallel calls', () => {
  const tool = (subtype, id) => ({
    type: 'tool_call',
    subtype,
    call_id: id,
    tool_call: { editToolCall: {} },
  })
  for (const boundary of ['thinking', 'assistant', 'started']) {
    const events = [
      { type: 'thinking', subtype: 'delta', text: 'Inspect' },
      tool('started', 'one'),
      tool('started', 'two'),
      tool('completed', 'one'),
      // Outstanding parallel work keeps these events in the first group.
      { type: 'thinking', subtype: 'delta', text: 'Continue' },
      { type: 'assistant', message: { content: 'Continue' } },
      tool('started', 'three'),
      tool('completed', 'two'),
      tool('completed', 'three'),
      ...(boundary === 'started'
        ? []
        : [{ type: boundary, message: { content: 'Next' } }]),
      tool('started', 'four'),
      tool('completed', 'four'),
      { type: 'result', is_error: false },
    ]
    const lines = events.map((event) => JSON.stringify(event))
    assert.equal(parseStream('cursor', lines.slice(0, 9).join('\n')).turns, 1)
    assert.equal(parseStream('cursor', lines.join('\n')).turns, 2)
    assert.equal(turnBudget('cursor', 1).push(lines.join('\n') + '\n'), true)
    assert.equal(turnBudget('cursor', 2).push(lines.join('\n') + '\n'), false)
  }
})

test('Cursor receives the prompt as one positional argument', async () => {
  const prompt = 'Please update "report.html"; keep its URL.'
  const result = await runProcess({
    command: [
      process.execPath,
      '-e',
      'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify(process.argv.slice(1))))',
    ],
    agent: 'cursor',
    prompt,
    timeoutMs: 1000,
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(JSON.parse(result.stdout), [prompt])
})
const marker = '<!-- artifactshare-skill\nversion: 46\nmanaged: true\n-->\n'
const skill = `---\nname: artifactshare\ndescription: Synthetic evaluation skill\n---\n${marker}Selected synthetic skill\n`
async function fixture(t) {
  const root = await temporary('skill-eval-test-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'version one 日本語')
  await mkdir(join(source, 'references'), { recursive: true })
  await writeFile(join(source, 'SKILL.md'), skill)
  await writeFile(join(source, 'references/share.md'), 'Synthetic reference')
  return { root, source, version: await skillVersion(source) }
}
test('planner accepts pnpm separator and dry-run needs only input files', async (t) => {
  const { source, root } = await fixture(t)
  const p = await plan([
    '--',
    '--dry-run',
    '--skill-version',
    source,
    '--combination',
    'codex:gpt-6.1-sol',
    '--scenario',
    'share',
    '--runs',
    '2',
    '--output-dir',
    join(root, 'output'),
  ])
  assert.equal(p.persona, 'free-owner')
  assert.equal(p.matrix.length, 2)
  assert.deepEqual(p.matrix[0].command, [
    'codex',
    'exec',
    '--skip-git-repo-check',
    '-m',
    'gpt-6.1-sol',
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ])
  await assert.rejects(access(p.outputDir))
  const result = await exec(
    process.execPath,
    [
      'scripts/skill-eval.mjs',
      '--',
      '--dry-run',
      '--persona',
      'team-owner',
      '--combination',
      'codex:gpt-6.1-sol',
      '--scenario',
      'share',
      '--skill-version',
      source,
    ],
    {
      env: {
        PATH: '',
        HOME: join(root, 'absent'),
        CODEX_HOME: join(root, 'absent'),
      },
    },
  )
  assert.equal(JSON.parse(result.stdout).matrix.length, 1)
  assert.equal(JSON.parse(result.stdout).persona, 'team-owner')
  for (const args of [
    ['--runs', '0'],
    ['--runs'],
    ['--scenario', 'unsupported'],
    ['--combination', 'cursor:unsupported'],
    ['--wat'],
    ['--skill-version', source, '--skill-version', source],
  ])
    await assert.rejects(plan(args))
})
test('Claude dry-run allows file tools for both models', async (t) => {
  const { source, root } = await fixture(t)
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const result = await exec(
      process.execPath,
      [
        'scripts/skill-eval.mjs',
        '--dry-run',
        '--combination',
        `claude:${model}`,
        '--scenario',
        'update',
        '--skill-version',
        source,
        '--max-turns',
        '7',
      ],
      { env: { PATH: '', HOME: join(root, 'absent') } },
    )
    assert.deepEqual(JSON.parse(result.stdout).matrix[0].command, [
      'claude',
      '-p',
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      '--max-turns',
      '7',
    ])
  }
})
test('planner accepts exactly the dev personas and rejects invalid input before preflight', async (t) => {
  const { source } = await fixture(t)
  for (const persona of [
    'free-owner',
    'plus-owner',
    'team-owner',
    'team-member',
  ]) {
    const options = await plan([
      '--skill-version',
      source,
      '--persona',
      persona,
    ])
    assert.equal(options.persona, persona)
  }
  await assert.rejects(
    plan(['--persona', 'unknown', '--skill-version', '/missing-skill']),
    /Unsupported persona unknown\npnpm skill-eval.*--persona/u,
  )
  await assert.rejects(
    plan(['--persona']),
    /Invalid or missing argument.*--persona/u,
  )
})
test('sign-in sends the selected persona without a screen scenario', async () => {
  for (const persona of [
    'free-owner',
    'plus-owner',
    'team-owner',
    'team-member',
  ]) {
    const token = await signIn(
      'http://localhost',
      persona,
      (origin, url, options) => {
        assert.equal(origin, 'http://localhost')
        assert.equal(url, 'http://localhost/api/auth/dev/sign-in')
        assert.equal(options.method, 'POST')
        assert.deepEqual(JSON.parse(options.body), { persona })
        return Response.json(
          { userId: 'sample' },
          {
            headers: {
              'set-cookie':
                'better-auth.session_token=sample-token.signature; Path=/',
            },
          },
        )
      },
    )
    assert.equal(token, 'sample-token')
  }
})
test('origin, output and skill guards reject unsafe destinations including aliases', async (t) => {
  for (const origin of [
    'http://localhost:5173',
    'https://127.0.0.1',
    'http://[::1]:3000',
  ])
    assert.equal(localOrigin(origin), origin)
  for (const origin of [
    'https://example.com',
    'http://localhost.example.com',
    'http://localhost@localhost',
    'file:///tmp',
    'http://localhost/path',
    'http://localhost?x=1',
    'http://localhost#x',
    'garbage',
  ])
    assert.throws(() => localOrigin(origin))
  const { root, source } = await fixture(t)
  await symlink(repository, join(root, 'checkout-alias'))
  await assert.rejects(
    outputPath(join(root, 'checkout-alias/results')),
    /outside/u,
  )
  await symlink(root, join(source, 'escaping'))
  await assert.rejects(skillVersion(source), /escaping/u)
})
test('local requests refuse redirects and missing dev authentication before execution', async () => {
  await assert.rejects(
    localRequest(
      'http://localhost',
      '/',
      {},
      () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://example.com' },
        }),
    ),
    /redirect/u,
  )
  await assert.rejects(
    signIn('http://localhost', 'free-owner', () =>
      Response.json({ userId: 'sample' }),
    ),
    /session token/u,
  )
  await assert.rejects(
    signIn('http://localhost', 'free-owner', () => {
      throw new Error('unreachable')
    }),
    /unreachable/u,
  )
  await assert.rejects(
    localRequest('http://localhost', 'https://example.com', {}, () => {
      assert.fail('must not fetch')
    }),
    /approved/u,
  )
})
test('agent environment strips secrets and inherited config while CLI keeps temporary HOME', () => {
  const env = environments({
    root: '/tmp/evaluation',
    baseUrl: 'http://localhost',
    token: 'synthetic-secret',
    inherited: {
      HOME: '/real',
      CODEX_HOME: '/real/codex',
      CLAUDE_CONFIG_DIR: '/real/claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ZDOTDIR: '/real/zsh',
      XDG_CONFIG_HOME: '/real/config',
      ARTIFACTSHARE_TOKEN: 'poison',
      ARTIFACTSHARE_BASE_URL: 'https://example.com',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--import poison',
      PATH: '/bin',
    },
  })
  assert.equal(env.agent.ARTIFACTSHARE_TOKEN, undefined)
  assert.equal(env.agent.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
  assert.equal(env.agent.NODE_OPTIONS, undefined)
  assert.equal(env.agent.ARTIFACTSHARE_BASE_URL, 'http://localhost')
  assert.equal(env.cli.ARTIFACTSHARE_TOKEN, 'synthetic-secret')
  assert.equal(env.cli.HOME, env.agent.HOME)
  assert.equal(env.agent.CODEX_HOME, '/tmp/evaluation/codex')
  assert.equal(env.agent.CLAUDECODE, undefined)
  assert.equal(env.agent.CLAUDE_CODE_ENTRYPOINT, undefined)
  assert.equal(env.agent.ZDOTDIR, env.agent.HOME)
  assert.equal(env.agent.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(env.cli.CLAUDE_CONFIG_DIR, undefined)
})
for (const agent of ['claude', 'codex', 'cursor'])
  test(`${agent} fixture correlates lifecycle, reads and terminal evidence`, async () => {
    const text = await readFile(
      `scripts/fixtures/skill-eval/${agent}.jsonl`,
      'utf8',
    )
    const record = parseStream(agent, text, '/tmp/work')
    assert.equal(record.complete, true)
    assert.equal(record.commands.length, 1)
    assert.equal(record.commands[0].exitCode, 0)
    assert.equal(record.referencesRead.length, 1)
    assert.equal(record.finalMessage, 'http://localhost:5173/a/sample')
    assert.equal(parseStream(agent, `${text}\n{broken`).complete, false)
    assert.equal(parseStream(agent, '').complete, false)
    assert.equal(
      parseStream(agent, text.split('\n').slice(0, -2).join('\n')).complete,
      false,
    )
  })
test('Claude counts parallel tools once per assistant message', () => {
  const assistant = {
    type: 'assistant',
    message: {
      id: 'parallel-turn',
      content: ['one', 'two', 'three'].map((id) => ({
        type: 'tool_use',
        id,
        name: 'Bash',
        input: { command: 'pwd' },
      })),
    },
  }
  const events = [
    assistant,
    assistant,
    ...['one', 'two', 'three'].map((id) => ({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: id, content: '/tmp/work' },
        ],
      },
    })),
    { type: 'result', subtype: 'success' },
  ]
  const record = parseStream(
    'claude',
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  assert.equal(record.complete, true)
  assert.equal(record.commands.length, 3)
  assert.equal(record.turns, 1)
  delete assistant.message.id
  assert.equal(parseStream('claude', JSON.stringify(assistant)).turns, 1)
})

test('Claude accepts string user and assistant content without losing completion', () => {
  const events = [
    {
      type: 'assistant',
      message: { content: 'Shared at http://localhost/a/sample' },
    },
    { type: 'user', message: { content: 'Thanks' } },
    { type: 'result', subtype: 'success' },
  ]
  const record = parseStream(
    'claude',
    events.map((event) => JSON.stringify(event)).join('\n'),
  )
  assert.equal(record.complete, true)
  assert.equal(record.malformed, 0)
  assert.equal(record.finalMessage, 'Shared at http://localhost/a/sample')
})

test('final URL scoring accepts Markdown and sentence punctuation', () => {
  const url = 'https://localhost:5173/a/sample'
  for (const finalMessage of [
    `**${url}**`,
    `[shared artifact](${url})`,
    `<${url}>`,
    `こちら：${url}。`,
    `（${url}）、`,
    `\`${url}\``,
    `_${url}_`,
    ...[
      '.',
      ',',
      ';',
      ':',
      '!',
      '?',
      '！',
      '？',
      '．',
      '，',
      '；',
      '：',
      '。',
      '、',
      '）',
      ']',
      ')',
      '}',
      '"',
      "'",
    ].map((suffix) => `${url}${suffix}`),
  ]) {
    assert.equal(
      score({
        record: { complete: true, finalMessage },
        server: { after: { share_url: url } },
        scenario: 'share',
      }).finalUrl.status,
      'pass',
      finalMessage,
    )
  }
})

test('JSON scoring requires an option before the argument terminator', () => {
  for (const [argv, expected] of [
    [['share', '--', '--json'], 'fail'],
    [['share', '--json', '--', 'report.html'], 'pass'],
    [['--json', 'share', 'report.html'], 'pass'],
    [['share', 'report.html', '--json'], 'pass'],
  ]) {
    assert.equal(
      score({
        record: { complete: true, finalMessage: '' },
        actions: [{ argv }],
        scenario: 'share',
      }).json.status,
      expected,
    )
  }
})

test('JSON scoring requires explicit JSON even for help and version probes', () => {
  const check = (argv, next = ['share', 'report.html', '--json']) =>
    score({
      record: { complete: true, finalMessage: '' },
      actions: [{ argv }, { argv: next }],
      scenario: 'share',
    }).json.status
  for (const flag of ['--help', '-h', '--version', '-v']) {
    assert.equal(check(['share', flag]), 'fail')
    assert.equal(check(['share', flag, '--json']), 'pass')
    assert.equal(check(['share', flag, '--', '--json']), 'fail')
    assert.equal(check([flag]), 'fail')
    assert.equal(check([flag, '--json']), 'pass')
    assert.equal(check(['share', '--', flag]), 'fail')
    assert.equal(check(['share', flag], ['share', 'report.html']), 'fail')
  }
  assert.equal(check(['help']), 'fail')
  assert.equal(check(['help', '--json']), 'pass')
  assert.equal(check(['share', 'help']), 'fail')
  assert.equal(check(['--', 'help']), 'fail')
  assert.equal(check(['help', 'report.html']), 'fail')
})

test('scoring requires persisted content, same identity and a changed version', () => {
  const record = { complete: true, finalMessage: 'http://localhost/a/sample' }
  const action = {
    argv: ['update', 'sample', 'report.html', '--json'],
    stdout: '{}',
  }
  const before = {
    id: 'sample',
    share_url: 'http://localhost/a/sample',
    version_id: 'old',
  }
  const server = {
    before,
    after: { ...before, version_id: 'new', content: 'Ready' },
    createdIds: [],
    expectedContent: 'Ready',
  }
  const base = { record, actions: [action], server, scenario: 'update' }
  assert.equal(score(base).identity.status, 'pass')
  assert.equal(score(base).recovery.status, 'not-applicable')
  assert.equal(score({ ...base, actions: [] }).json.status, 'fail')
  assert.equal(
    score({ ...base, actions: [{ argv: ['help'] }] }).json.status,
    'fail',
  )
  assert.equal(
    score({ ...base, server: { ...server, createdIds: ['extra'] } }).identity
      .status,
    'fail',
  )
  assert.equal(
    score({ ...base, server: { ...server, after: before } }).identity.status,
    'fail',
  )
  assert.equal(
    score({
      ...base,
      server: { ...server, after: { ...server.after, content: 'Wrong' } },
    }).content.status,
    'fail',
  )
  assert.equal(score({ ...base, server: {} }).identity.status, 'unknown')
  assert.equal(score({ ...base, status: 'timeout' }).identity.status, 'unknown')
  assert.equal(
    score({
      ...base,
      record: { ...record, finalMessage: 'http://localhost/a/wrong' },
    }).finalUrl.status,
    'fail',
  )
  const recovery = {
    ...action,
    stdout: JSON.stringify({
      error: {
        recovery: {
          kind: 'run_command',
          command: 'artifactshare projects list --json',
        },
      },
    }),
  }
  assert.equal(
    score({ ...base, actions: [recovery] }).recovery.status,
    'unknown',
  )
  assert.equal(
    score({ ...base, actions: [recovery, action] }).recovery.status,
    'fail',
  )
  assert.equal(
    score({
      ...base,
      actions: [recovery, { argv: ['projects', 'list', '--json'] }],
    }).recovery.status,
    'pass',
  )
})
test('recovery compares complete actions while allowing supported boolean flag placement', () => {
  const check = (command, argv) =>
    score({
      scenario: 'share',
      record: { complete: true, finalMessage: '' },
      actions: [
        {
          argv: ['share', '--json'],
          stdout: JSON.stringify({
            error: { recovery: { kind: 'run_command', command } },
          }),
        },
        { argv },
      ],
    }).recovery.status
  const command = 'artifactshare projects list --json'
  for (const argv of [
    ['--json', 'projects', 'list'],
    ['projects', '--json', 'list'],
    ['projects', 'list', '--json'],
  ])
    assert.equal(check(command, argv), 'pass')
  for (const extra of [
    ['--help'],
    ['-h'],
    ['--version'],
    ['-v'],
    ['--profile', 'another'],
    ['--limit=1'],
    ['unexpected'],
    ['--', '--help'],
  ])
    assert.equal(
      check(command, ['projects', 'list', '--json', ...extra]),
      'fail',
    )
  assert.equal(
    check('artifactshare profiles use sample', [
      '--json',
      'profiles',
      'use',
      'sample',
    ]),
    'pass',
  )
  assert.equal(
    check('artifactshare artifacts get sample --json', [
      '--json',
      'artifacts',
      'get',
      'other',
    ]),
    'fail',
  )
  assert.equal(check('artifactshare --help', ['--json', '-h']), 'pass')
  assert.equal(check(command, ['projects', 'list', '--', '--json']), 'fail')
  assert.equal(check(command, undefined), 'unknown')
})
test('recovery envelopes survive warnings around compact and pretty-printed JSON', () => {
  const envelope = {
    error: {
      message: 'Select a project before sharing.',
      recovery: {
        kind: 'run_command',
        command: 'artifactshare projects list --json',
      },
    },
  }
  for (const channel of ['stdout', 'stderr'])
    for (const indent of [undefined, 2]) {
      const output = `Warning: local TLS verification is disabled.\n${JSON.stringify(envelope, null, indent)}\nWarning: diagnostic complete.\n`
      const action = { argv: ['share', '--json'], [channel]: output }
      const check = (next) =>
        score({
          scenario: 'share',
          record: { complete: true, finalMessage: '' },
          actions: [action, ...next],
        }).recovery.status
      assert.equal(check([{ argv: ['projects', 'list', '--json'] }]), 'pass')
      assert.equal(check([{ argv: ['share', '--json'] }]), 'fail')
      assert.equal(check([]), 'unknown')
      assert.equal(action[channel], output)
    }
})
test('report compares versions and excludes contamination and incomplete results', () => {
  const run = {
    combination: 'codex:gpt-6.1-sol',
    scenario: 'share',
    version: 'one',
    status: 'completed',
    skills: { complete: true, contaminated: false },
    checks: { json: { status: 'pass' } },
  }
  const report = markdown({
    persona: 'plus-owner',
    combinations: [run.combination],
    scenarios: ['share'],
    versions: [{ label: 'one' }, { label: 'two' }],
    runs: [
      run,
      {
        ...run,
        status: 'contaminated',
        skills: { complete: true, contaminated: true },
      },
      { ...run, version: 'two', status: 'timeout' },
    ],
  })
  assert.match(report, /^# Local skill evaluation — plus-owner\n/u)
  assert.match(report, /\| Check \| one \| two \|/u)
  assert.match(report, /1\/1; unknown 0; N\/A 0 \| 0\/0/u)
  assert.match(report, /contaminated 1/u)
  assert.match(report, /two: incomplete 1/u)
})
test('guard handles all base flag spellings and blocks unsupported package runners', () => {
  const npm = [
    'exec',
    '--yes',
    '--package=@artifactshare/cli',
    '--',
    'artifactshare',
  ]
  for (const bin of ['artifactshare', 'npm'])
    for (const flag of ['--base-url', '--baseUrl'])
      for (const args of [
        [flag, 'https://example.com'],
        [`${flag}=https://example.com`],
      ])
        assert.throws(() =>
          guardedArguments(
            bin,
            [...(bin === 'npm' ? npm : []), 'share', ...args],
            'http://localhost',
          ),
        )
  assert.deepEqual(
    guardedArguments(
      'npm',
      [...npm, 'help', '--json', '--baseUrl=http://localhost'],
      'http://localhost',
    ),
    ['help', '--json', '--baseUrl=http://localhost'],
  )
  for (const bin of ['npx', 'pnpm', 'bunx'])
    assert.throws(() => guardedArguments(bin, [], 'http://localhost'))
  assert.throws(() => guardedArguments('npm', ['install'], 'http://localhost'))
  assert.equal(
    redact('a synthetic-secret b', ['synthetic-secret']),
    'a [REDACTED] b',
  )
})
test('timeouts, event turn budget, interruption and spawn errors terminate processes', async () => {
  const base = {
    cwd: repository,
    env: process.env,
    timeoutMs: 80,
    command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
  }
  assert.equal((await runProcess(base)).status, 'timeout')
  const controller = new AbortController()
  const pending = runProcess({
    ...base,
    timeoutMs: 5000,
    signal: controller.signal,
  })
  controller.abort()
  assert.equal((await pending).status, 'interrupted')
  const event = JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'one',
      type: 'command_execution',
      command: 'pwd',
      exit_code: 0,
    },
  })
  const limited = await runProcess({
    ...base,
    agent: 'codex',
    maxTurns: 1,
    timeoutMs: 5000,
    command: [
      process.execPath,
      '-e',
      `console.log(${JSON.stringify(event)});console.log(${JSON.stringify(event.replace('one', 'two'))});setInterval(()=>{},1000)`,
    ],
  })
  assert.equal(limited.status, 'turn-limit')
  assert.equal(
    (await runProcess({ ...base, command: ['/nonexistent-agent'] })).status,
    'infrastructure-error',
  )
})
test('all evaluation files have exact canonical manifest entries', async () => {
  const files = [
    'scripts/skill-eval.mjs',
    'scripts/skill-eval.test.mjs',
    'scripts/lib/walkthrough-cli-environment.mjs',
  ]
  for (const directory of [
    'scripts/lib/skill-eval',
    'scripts/fixtures/skill-eval',
  ])
    for (const name of await readdir(directory))
      files.push(`${directory}/${name}`)
  const manifest = loadBoundaryManifest(repository)
  for (const file of files) assert.ok(manifest.canonical.includes(file), file)
  assert.ok(
    inspectTree(files, manifest).every(
      (row) => row.classification === 'canonical',
    ),
  )
})
test(
  'real copied CLI and npm shim install only selected skill; source and checkout stay unchanged',
  { timeout: 120000 },
  async (t) => {
    const { root, version } = await fixture(t)
    // test:scripts is also called before CLI build in the static CI lane.
    try {
      await access(join(repository, 'packages/cli/dist/index.js'))
    } catch {
      await exec('pnpm', ['--filter', '@artifactshare/cli', 'build'], {
        cwd: repository,
        timeout: 90000,
      })
    }
    const original = await readFile(
      'packages/cli/skills/artifactshare/SKILL.md',
    )
    const dist = await readFile('packages/cli/dist/index.js')
    const selected = await overlay(version)
    t.after(() => rm(selected.root, { recursive: true, force: true }))
    assert.equal(selected.derivedCompanion, true)
    assert.deepEqual(
      JSON.parse(await readFile(join(selected.root, 'package.json'), 'utf8')),
      JSON.parse(await readFile('packages/cli/package.json', 'utf8')),
    )
    const realHome = join(root, 'real-home')
    await mkdir(join(realHome, '.codex'), { recursive: true })
    await writeFile(
      join(realHome, '.codex/auth.json'),
      'synthetic authentication',
    )
    const run = await createRun({
      agent: 'codex',
      version,
      selectedOverlay: selected,
      baseUrl: 'http://localhost:5173',
      token: 'synthetic-token',
      realHome,
    })
    t.after(run.cleanup)
    assert.deepEqual(await readdir(run.workdir), ['.agents'])
    assert.equal(
      (await stat(join(run.root, 'launcher.json'))).mode & 0o777,
      0o600,
    )
    assert.equal(
      await readFile(join(run.root, 'codex/auth.json'), 'utf8'),
      'synthetic authentication',
    )
    const npm = [
      'exec',
      '--yes',
      '--package=@artifactshare/cli',
      '--',
      'artifactshare',
    ]
    const installed = join(
      run.root,
      'home/.agents/skills/artifactshare/SKILL.md',
    )
    for (const bin of ['artifactshare', 'npm']) {
      const prefix = bin === 'npm' ? npm : []
      await exec(
        join(run.root, 'bin', bin),
        [...prefix, 'skills', 'ensure', '--tool', 'auto', '--json'],
        { cwd: run.workdir, env: run.env.agent },
      )
      assert.equal(await readFile(installed, 'utf8'), skill)
      await rm(installed)
      await assert.rejects(
        exec(join(run.root, 'bin', bin), [...prefix, 'open', '', '--json'], {
          cwd: run.workdir,
          env: run.env.agent,
        }),
      )
      assert.equal(await readFile(installed, 'utf8'), skill)
      await assert.rejects(
        exec(
          join(run.root, 'bin', bin),
          [...prefix, 'help', '--baseUrl=https://example.com'],
          { cwd: run.workdir, env: run.env.agent },
        ),
      )
    }
    const actions = (await readFile(run.config.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(actions.length, 6)
    assert.equal(actions[3].bin, 'npm')
    assert.equal(actions[3].fingerprint, version.fingerprint)
    const cliVersion = await exec(
      join(run.root, 'bin/artifactshare'),
      ['--version'],
      { cwd: run.workdir, env: run.env.agent },
    )
    assert.equal(
      cliVersion.stdout.trim(),
      JSON.parse(await readFile('packages/cli/package.json', 'utf8')).version,
    )
    const initial = await inventory(run.root, selected.files)
    assert.equal(
      initial.files.every((file) => file.expected),
      true,
    )
    const history = {
      files: [],
      errors: [],
      complete: true,
      contaminated: false,
    }
    observe(history, initial)
    await writeFile(installed, 'Foreign skill')
    observe(history, await inventory(run.root, selected.files))
    await writeFile(installed, skill)
    observe(history, await inventory(run.root, selected.files))
    assert.equal(history.contaminated, true)
    assert.equal(
      history.files.some(
        (file) => file.fingerprint === fingerprint('Foreign skill'),
      ),
      true,
    )
    assert.deepEqual(
      await readFile('packages/cli/skills/artifactshare/SKILL.md'),
      original,
    )
    assert.deepEqual(await readFile('packages/cli/dist/index.js'), dist)
    await run.cleanup()
    await assert.rejects(access(run.root))
    assert.equal(
      await readFile(join(realHome, '.codex/auth.json'), 'utf8'),
      'synthetic authentication',
    )
  },
)

test('subprocess launchers preserve argv, stdin and exit status without invoking package runners', async (t) => {
  const { root, version } = await fixture(t)
  const checkout = join(root, 'synthetic checkout')
  await mkdir(join(checkout, 'dist'), { recursive: true })
  await writeFile(
    join(checkout, 'package.json'),
    JSON.stringify({
      name: '@artifactshare/cli',
      version: '0.19.2',
      type: 'module',
    }),
  )
  await symlink(
    join(repository, 'packages/cli/node_modules'),
    join(checkout, 'node_modules'),
  )
  await writeFile(
    join(checkout, 'dist/index.js'),
    `import { readFileSync, appendFileSync } from 'node:fs';
import { fetch } from 'undici';
if (process.argv[2] === 'remote') {
  try { await fetch('https://example.com'); process.exitCode = 99 }
  catch (error) { console.log(error.cause.message) }
} else {
  appendFileSync(process.env.HOME + '/executions', 'executed\\n');
  console.log(JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8'), token: process.env.ARTIFACTSHARE_TOKEN, origin: process.env.ARTIFACTSHARE_BASE_URL }));
  process.exitCode = 7;
}
`,
  )
  const selected = await overlay(version, checkout)
  t.after(() => rm(selected.root, { recursive: true, force: true }))
  const run = await createRun({
    agent: 'claude',
    version,
    selectedOverlay: selected,
    baseUrl: 'http://localhost:5173',
    token: 'fixture-token',
    linkCredentials: false,
  })
  t.after(run.cleanup)
  assert.deepEqual(await readdir(run.workdir), ['.claude'])
  const npmPrefix = [
    'exec',
    '--yes',
    '--package=@artifactshare/cli',
    '--',
    'artifactshare',
  ]
  for (const bin of ['artifactshare', 'npm']) {
    const prefix = bin === 'npm' ? npmPrefix : []
    const pending = exec(
      join(run.root, 'bin', bin),
      [...prefix, 'probe', 'space 日本語'],
      {
        cwd: run.workdir,
        env: {
          ...run.env.agent,
          ARTIFACTSHARE_BASE_URL: 'https://example.com',
        },
      },
    )
    pending.child.stdin.end('input bytes')
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 7)
      const body = JSON.parse(error.stdout)
      assert.deepEqual(body.argv, ['probe', 'space 日本語'])
      assert.equal(body.stdin, 'input bytes')
      assert.equal(body.origin, 'http://localhost:5173')
      return true
    })
    for (const flag of ['--base-url', '--baseUrl'])
      for (const args of [
        [flag, 'https://example.com'],
        [`${flag}=https://example.com`],
      ]) {
        await assert.rejects(
          exec(join(run.root, 'bin', bin), [...prefix, ...args], {
            cwd: run.workdir,
            env: run.env.agent,
          }),
          /local HTTP/u,
        )
      }
  }
  for (const [bin, args] of [
    ['npm', ['install']],
    ['npx', ['@artifactshare/cli']],
    ['pnpm', ['dlx', '@artifactshare/cli']],
    ['bunx', ['@artifactshare/cli']],
  ])
    await assert.rejects(
      exec(join(run.root, 'bin', bin), args, {
        cwd: run.workdir,
        env: run.env.agent,
      }),
    )
  assert.equal(
    await readFile(join(run.root, 'home/executions'), 'utf8'),
    'executed\nexecuted\n',
  )
  const remote = await exec(join(run.root, 'bin/artifactshare'), ['remote'], {
    cwd: run.workdir,
    env: run.env.agent,
  })
  assert.match(remote.stdout, /refused a request outside/u)
  const log = await readFile(run.config.log, 'utf8')
  assert.ok(!log.includes('fixture-token'))
  assert.ok(log.includes('[REDACTED]'))
  const actions = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(actions.filter((action) => action.exitCode === 7).length, 2)
  assert.equal(
    actions.filter((action) => action.bin === 'npm' && action.exitCode === 7)
      .length,
    1,
  )
})

test('failed update seed reports the CLI error without starting the agent', async (t) => {
  const { executeCase } = await import('./skill-eval.mjs')
  const { root, version } = await fixture(t)
  const commands = []
  const result = await executeCase(
    {
      combination: 'codex:gpt-6.1-sol',
      scenario: 'update',
      version: version.label,
      command: ['fake-agent'],
    },
    { baseUrl: 'http://localhost:5173', timeoutMs: 1000, maxTurns: 2 },
    version,
    {
      target: join(root, 'unused'),
      files: version.files,
      derivedCompanion: true,
    },
    { list: () => Promise.resolve([]) },
    'fixture-token',
    root,
    new AbortController().signal,
    {
      createRun: (options) => createRun({ ...options, linkCredentials: false }),
      runProcess(options) {
        commands.push(options.command)
        return {
          status: 'infrastructure-error',
          exitCode: 1,
          stdout: '',
          stderr: JSON.stringify({
            ok: false,
            command: 'share',
            error: {
              code: 'validation_failed',
              message: 'Workspace visibility is unavailable for this account.',
            },
          }),
        }
      },
    },
  )
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].slice(1), [
    'share',
    'report.html',
    '--visibility',
    'private',
    '--json',
  ])
  assert.equal(result.status, 'infrastructure-error')
  assert.match(result.error, /Update artifact seed failed/u)
  assert.match(result.error, /validation_failed/u)
  assert.match(
    result.error,
    /Workspace visibility is unavailable for this account\./u,
  )
  assert.equal(result.cleanup.temporary, true)
})

test('fake share/update executions retain evidence and clean only their owned files and artifacts', async (t) => {
  const { executeCase } = await import('./skill-eval.mjs')
  const { root, version } = await fixture(t)
  for (const scenario of ['share', 'update'])
    for (const variant of [
      'success',
      'global-flags',
      'deleted-extra',
      'deleted-first',
      'timeout',
      'contaminated',
      'truncated-log',
    ]) {
      const artifacts = new Map([
        ['unrelated', { id: 'unrelated', version_id: 'original' }],
      ])
      let run
      const target = {
        id: 'sample',
        share_url: 'http://localhost:5173/a/sample',
        version_id: 'old',
        content: 'Draft schedule',
      }
      const client = {
        list: () => Promise.resolve([...artifacts.values()]),
        get: (id) => {
          if (!artifacts.has(id))
            return Promise.reject(new Error('Artifact readback returned 404'))
          return Promise.resolve({ ...artifacts.get(id) })
        },
        delete: (id) => {
          artifacts.delete(id)
          return Promise.resolve({})
        },
      }
      const selected = {
        target: join(root, 'unused'),
        files: version.files,
        derivedCompanion: true,
      }
      const runtime = {
        async createRun(options) {
          run = await createRun({ ...options, linkCredentials: false })
          return run
        },
        async runProcess(options) {
          if (options.command[0].endsWith('/artifactshare')) {
            assert.deepEqual(options.command.slice(1), [
              'share',
              'report.html',
              '--visibility',
              'private',
              '--json',
            ])
            artifacts.set('sample', { ...target })
            return {
              status: 'completed',
              stdout: JSON.stringify({ data: { artifact: { id: 'sample' } } }),
              stderr: '',
            }
          }
          artifacts.set('sample', {
            ...target,
            version_id: 'new',
            content:
              scenario === 'share'
                ? 'Draft schedule'
                : 'Launch is ready for Friday.',
          })
          const action = {
            argv:
              variant === 'global-flags'
                ? [
                    '--json',
                    scenario === 'share' ? 'share' : 'update',
                    'report.html',
                  ]
                : [
                    scenario === 'share' ? 'share' : 'update',
                    'report.html',
                    '--json',
                  ],
            exitCode: 0,
            stdout: JSON.stringify({
              command: scenario === 'share' ? 'share' : 'update',
              ok: true,
              data: { artifact: { id: 'sample' } },
            }),
          }
          const extraActions = ['deleted-extra', 'deleted-first'].includes(
            variant,
          )
            ? [
                {
                  argv: ['share', 'report.html', '--json'],
                  exitCode: 0,
                  stdout: JSON.stringify({
                    command: 'share',
                    ok: true,
                    data: { artifact: { id: 'extra' } },
                  }),
                },
                {
                  argv: [
                    'artifacts',
                    'delete',
                    variant === 'deleted-first' ? 'sample' : 'extra',
                    '--json',
                  ],
                  exitCode: 0,
                  stdout: '{}',
                },
              ]
            : []
          if (variant === 'deleted-first') {
            artifacts.delete('sample')
            artifacts.set('extra', { ...target, id: 'extra' })
          }
          // One of the shares was deleted before the final server snapshot.
          await writeFile(
            run.config.log,
            [action, ...extraActions]
              .map((entry) => JSON.stringify(entry))
              .join('\n') +
              '\n' +
              (variant === 'truncated-log' ? '{"argv":' : ''),
          )
          if (variant === 'contaminated')
            await writeFile(
              join(
                run.workdir,
                '.agents/skills/artifactshare/references/share.md',
              ),
              'Foreign reference',
            )
          return {
            status: variant === 'timeout' ? 'timeout' : 'completed',
            stdout:
              JSON.stringify({
                type: 'item.completed',
                item: { type: 'agent_message', text: target.share_url },
              }) +
              '\n' +
              JSON.stringify({ type: 'turn.completed' }) +
              '\n',
            stderr: '',
            exitCode: 0,
          }
        },
      }
      const item = {
        combination: 'codex:gpt-6.1-sol',
        scenario,
        version: version.label,
        command: ['fake-agent'],
      }
      const output = join(root, `${scenario}-${variant}`)
      await mkdir(output)
      const result = await executeCase(
        item,
        { baseUrl: 'http://localhost:5173', timeoutMs: 1000, maxTurns: 2 },
        version,
        selected,
        client,
        'fixture-token',
        output,
        new AbortController().signal,
        runtime,
      )
      assert.equal(
        result.status,
        ['success', 'global-flags', 'deleted-extra', 'deleted-first'].includes(
          variant,
        )
          ? 'completed'
          : variant === 'truncated-log'
            ? 'incomplete'
            : variant,
      )
      assert.equal(
        result.checks.content.status,
        ['success', 'global-flags', 'deleted-extra'].includes(variant)
          ? 'pass'
          : 'unknown',
      )
      if (scenario === 'update' && variant === 'success')
        assert.equal(result.checks.identity.status, 'pass')
      if (['deleted-extra', 'deleted-first'].includes(variant)) {
        assert.deepEqual(
          [...result.server.createdIds].sort(),
          scenario === 'share' ? ['extra', 'sample'] : ['extra'],
        )
        assert.equal(
          result.checks[scenario === 'share' ? 'created' : 'identity'].status,
          'fail',
        )
      }
      if (variant === 'deleted-first') {
        assert.equal(result.server.after, undefined)
        assert.match(result.server.error, /404/u)
      }
      if (variant === 'truncated-log') {
        assert.equal(result.actions.length, 1)
        assert.equal(result.actionLogErrors.length, 1)
        assert.match(await readFile(result.raw.actions, 'utf8'), /argv/u)
      }
      assert.equal(result.cleanup.temporary, true)
      await assert.rejects(access(run.root))
      assert.deepEqual([...artifacts.keys()], ['unrelated'])
      assert.ok(
        (await readFile(result.raw.stdout, 'utf8')).includes('turn.completed'),
      )
    }
})

test('inventory ignores other skills, distinguishes path mappings and retains changes', async (t) => {
  const { root, version } = await fixture(t)
  await mkdir(join(root, 'home'))
  await mkdir(join(root, 'codex'))
  await mkdir(join(root, 'work/other'), { recursive: true })
  await writeFile(join(root, 'work/other/SKILL.md'), 'Unrelated account skill')
  let snapshot = await inventory(root, version.files)
  assert.equal(snapshot.files.length, 0)
  await mkdir(join(root, 'work/unknown/artifactshare/references'), {
    recursive: true,
  })
  await writeFile(
    join(root, 'work/unknown/artifactshare/references/foreign.md'),
    version.files['SKILL.md'],
  )
  snapshot = await inventory(root, version.files)
  assert.equal(snapshot.files[0].expected, false)
  assert.equal(snapshot.files[0].location, 'unknown')
  const history = { files: [], errors: [], complete: true, contaminated: false }
  observe(history, snapshot)
  await writeFile(
    join(root, 'work/unknown/artifactshare/references/foreign.md'),
    'Changed',
  )
  observe(history, await inventory(root, version.files))
  assert.equal(history.files[0].change, 'initial')
  assert.equal(history.files[1].change, 'changed')
  await rm(join(root, 'home'), { recursive: true })
  observe(history, await inventory(root, version.files))
  assert.equal(history.complete, false)
})

test('malformed shapes remain incomplete and duplicate tool completions do not consume turns', () => {
  const complete = { type: 'turn.completed' }
  const command = {
    type: 'item.completed',
    item: {
      id: 'sample',
      type: 'command_execution',
      command: 'pwd',
      exit_code: 0,
    },
  }
  const stream = [command, command, complete].map(JSON.stringify).join('\n')
  assert.equal(parseStream('codex', stream).turns, 1)
  for (const malformed of [
    null,
    [],
    {
      type: 'item.completed',
      item: { type: 'command_execution', command: {}, exit_code: 0 },
    },
  ])
    assert.equal(
      parseStream('codex', `${stream}\n${JSON.stringify(malformed)}`).complete,
      false,
    )
  const recovery = {
    argv: ['share', '--json'],
    stdout: JSON.stringify({
      error: {
        recovery: {
          kind: 'run_command',
          command:
            'npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json',
        },
      },
    }),
  }
  assert.equal(
    score({
      scenario: 'share',
      record: { complete: true, finalMessage: '' },
      actions: [recovery, { argv: ['projects', 'list', '--json'] }],
    }).recovery.status,
    'pass',
  )
})

test('turn limits allow an exact-budget final answer and reject excess cycles in any chunk layout', async () => {
  const cycle = (id) => ({
    type: 'item.completed',
    item: { id, type: 'command_execution', command: 'pwd', exit_code: 0 },
  })
  const terminal = { type: 'turn.completed' }
  for (const count of [1, 2]) {
    const stream =
      [
        ...Array.from({ length: count }, (_, index) => cycle(String(index))),
        terminal,
      ]
        .map(JSON.stringify)
        .join('\n') + '\n'
    for (const chunks of [[stream], stream.split(/(?<=\n)/u), [...stream]]) {
      const budget = turnBudget('codex', 1, repository)
      const exceeded = chunks.map((chunk) => budget.push(chunk)).some(Boolean)
      assert.equal(exceeded || budget.finish(), count > 1)
    }
    const result = await runProcess({
      command: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(stream)})`,
      ],
      cwd: repository,
      env: process.env,
      timeoutMs: 5000,
      maxTurns: 1,
      agent: 'codex',
    })
    assert.equal(result.status, count === 1 ? 'completed' : 'turn-limit')
    assert.ok(result.stdout.includes('turn.completed'))
  }
  const noNewline = turnBudget('codex', 1, repository)
  assert.equal(
    noNewline.push(
      JSON.stringify(cycle('one')) + '\n' + JSON.stringify(cycle('two')),
    ),
    false,
  )
  assert.equal(noNewline.finish(), true)
})

test('Claude keeps its default Keychain identity while HOME isolates project and user configuration', async (t) => {
  const { root, version } = await fixture(t)
  const realHome = join(root, 'sign-in source')
  const keychains = join(realHome, 'Library/Keychains')
  await mkdir(keychains, { recursive: true })
  await writeFile(join(keychains, 'sentinel'), 'unchanged')
  const run = await createRun({
    agent: 'claude',
    version,
    selectedOverlay: { target: join(root, 'unused'), files: version.files },
    baseUrl: 'http://localhost',
    token: 'synthetic-token',
    realHome,
    inherited: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: '/real/config' },
  })
  t.after(run.cleanup)
  assert.equal(run.env.agent.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(run.env.cli.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(run.env.agent.HOME, join(run.root, 'home'))
  assert.equal(
    await readlink(join(run.root, 'home/Library/Keychains')),
    keychains,
  )
  assert.deepEqual(await readdir(run.workdir), ['.claude'])
  assert.deepEqual((await readdir(join(run.root, 'home'))).sort(), [
    '.bash_profile',
    '.profile',
    '.zprofile',
    'Library',
  ])
  await run.cleanup()
  assert.equal(await readFile(join(keychains, 'sentinel'), 'utf8'), 'unchanged')
})

test('inventory tolerates unrelated rename churn and installer staging while continuing the scan', async (t) => {
  const { root, version } = await fixture(t)
  await mkdir(join(root, 'home'))
  await mkdir(join(root, 'codex'))
  const skillRoot = join(root, 'work/.agents/skills/artifactshare')
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), skill)
  await writeFile(join(skillRoot, '.artifactshare-synthetic.tmp'), '')
  const transient = join(root, 'work/temporary-config')
  await writeFile(transient, 'temporary')
  const io = {
    lstat,
    readFile,
    async readdir(path, options) {
      const entries = await readdir(path, options)
      if (path === join(root, 'work')) await rm(transient)
      return entries
    },
  }
  const snapshot = await inventory(root, version.files, { live: true, io })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['work/.agents/skills/artifactshare/SKILL.md'],
  )
  assert.equal(snapshot.files[0].expected, true)
  const denied = await inventory(root, version.files, {
    io: {
      ...io,
      readdir,
      lstat: () =>
        Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    },
  })
  assert.equal(denied.complete, false)
})

test('partial selected-skill writes stay pending until reconciliation, without hiding lasting or foreign changes', async (t) => {
  const { root, version } = await fixture(t)
  await mkdir(join(root, 'home'))
  await mkdir(join(root, 'codex'))
  const skillRoot = join(root, 'work/.agents/skills/artifactshare')
  await mkdir(skillRoot, { recursive: true })
  const path = join(skillRoot, 'SKILL.md')
  const history = () => ({
    files: [],
    errors: [],
    complete: true,
    contaminated: false,
  })
  for (const partial of ['', skill.slice(0, 45)]) {
    const observed = history()
    await writeFile(path, partial)
    observe(observed, await inventory(root, version.files, { live: true }))
    assert.equal(observed.contaminated, false)
    assert.equal(observed.complete, true)
    assert.equal(Object.keys(observed.pending).length, 1)
    await writeFile(path, skill)
    observe(observed, await inventory(root, version.files))
    assert.equal(observed.contaminated, false)
    assert.equal(observed.complete, true)
    assert.deepEqual(observed.pending, {})
    assert.equal(observed.files[0].pending, true)
    assert.equal(observed.files.at(-1).expected, true)
  }
  await writeFile(path, '')
  const lasting = history()
  observe(lasting, await inventory(root, version.files, { live: true }))
  observe(lasting, await inventory(root, version.files))
  assert.equal(lasting.contaminated, true)
  const removed = history()
  observe(removed, await inventory(root, version.files, { live: true }))
  await rm(path)
  observe(removed, await inventory(root, version.files))
  assert.equal(removed.complete, false)
  await writeFile(path, 'Foreign skill')
  const foreign = history()
  observe(foreign, await inventory(root, version.files, { live: true }))
  await writeFile(path, skill)
  observe(foreign, await inventory(root, version.files))
  assert.equal(foreign.contaminated, true)
})

test('action log salvage retains valid records around malformed lines and a truncated tail', async (t) => {
  const { actionsAt } = await import('./skill-eval.mjs')
  const { root } = await fixture(t)
  const path = join(root, 'actions.jsonl')
  const first = {
    argv: ['--json', 'share', 'report.html'],
    stdout: JSON.stringify({
      command: 'share',
      ok: true,
      data: { artifact: { id: 'sample' } },
    }),
    exitCode: 0,
  }
  const second = { argv: ['whoami', '--json'], exitCode: 0 }
  await writeFile(
    path,
    JSON.stringify(first) +
      '\nmalformed\n' +
      JSON.stringify(second) +
      '\n{"argv":',
  )
  const parsed = await actionsAt(path)
  assert.deepEqual(parsed.actions, [first, second])
  assert.deepEqual(
    parsed.errors.map((error) => error.line),
    [2, 4],
  )
  assert.ok(parsed.raw.endsWith('{"argv":'))
})

test('login profiles restore guarded commands after system PATH reordering', async (t) => {
  const { root, version } = await fixture(t)
  const run = await createRun({
    agent: 'codex',
    version,
    selectedOverlay: { target: join(root, 'unused'), files: version.files },
    baseUrl: 'http://localhost',
    token: 'synthetic-token',
    linkCredentials: false,
  })
  t.after(run.cleanup)
  for (const profile of ['.zprofile', '.bash_profile', '.profile']) {
    const source = await readFile(join(run.env.agent.HOME, profile), 'utf8')
    const result = await exec('/bin/sh', ['-c', source + 'command -v npm'], {
      env: { ...run.env.agent, PATH: '/usr/bin:/bin' },
    })
    assert.equal(result.stdout.trim(), run.env.agent.HOME + '/../bin/npm')
  }
  if (process.platform === 'darwin') {
    const result = await exec('/bin/zsh', ['-lc', 'command -v npm'], {
      env: run.env.agent,
    })
    assert.equal(result.stdout.trim(), run.env.agent.HOME + '/../bin/npm')
  }
})

test('Claude error result cannot establish successful completion', () => {
  const record = parseStream(
    'claude',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Synthetic failure',
    }),
  )
  assert.equal(record.complete, false)
  assert.equal(record.errors.length, 1)
  assert.equal(record.finalMessage, 'Synthetic failure')
})

test('CODEX_HOME skill changes contaminate the run and retain user location evidence', async (t) => {
  const { root, version } = await fixture(t)
  for (const dir of ['home', 'work', 'codex']) await mkdir(join(root, dir))
  const history = { files: [], errors: [], complete: true, contaminated: false }
  observe(history, await inventory(root, version.files))
  const target = join(root, 'codex/skills/artifactshare')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), 'Different selected version')
  observe(history, await inventory(root, version.files))
  assert.equal(history.complete, true)
  assert.equal(history.contaminated, true)
  assert.equal(history.files[0].path, 'codex/skills/artifactshare/SKILL.md')
  assert.equal(history.files[0].scope, 'user')
  assert.equal(history.files[0].location, 'codex')
  assert.equal(history.files[0].change, 'created')
})

test('Cursor defaults, command, placement and credential links stay isolated', async (t) => {
  const { root, source } = await fixture(t)
  const realHome = join(root, 'real-home')
  await mkdir(join(realHome, 'Library/Keychains'), { recursive: true })
  await mkdir(join(realHome, '.cursor'), { recursive: true })
  const realConfig = join(realHome, '.cursor/cli-config.json')
  await writeFile(realConfig, '{"fixture":true}')
  const before = await stat(realConfig)
  for (const mdc of [false, true]) {
    if (mdc) await writeFile(join(source, 'artifactshare.mdc'), marker + 'Rule')
    const options = await plan(['--dry-run', '--skill-version', source])
    assert.ok(options.combinations.includes('cursor:grok-4.7-high'))
    assert.deepEqual(options.scenarios, ['share', 'update', 'comments'])
    const item = options.matrix.find(
      (entry) =>
        entry.combination === 'cursor:grok-4.7-high' &&
        entry.scenario === 'comments',
    )
    assert.deepEqual(item.command, [
      'cursor-agent',
      '-p',
      '--trust',
      '-f',
      '--model',
      'grok-4.7-high',
      '--output-format',
      'stream-json',
    ])
    assert.equal(
      item.layout.skill,
      mdc ? '.cursor/rules/artifactshare.mdc' : '.cursor/skills/artifactshare',
    )
    const version = options.versions[0]
    const run = await createRun({
      agent: 'cursor',
      version,
      selectedOverlay: { target: join(root, 'unused'), files: version.files },
      baseUrl: 'http://localhost:5173',
      token: 'fixture',
      realHome,
    })
    try {
      assert.deepEqual(await readdir(run.workdir), ['.cursor'])
      assert.deepEqual(await readdir(join(run.env.agent.HOME, '.cursor')), [
        'cli-config.json',
      ])
      assert.equal(
        await readlink(join(run.env.agent.HOME, '.cursor/cli-config.json')),
        realConfig,
      )
      assert.equal(
        await readlink(join(run.env.agent.HOME, 'Library/Keychains')),
        join(realHome, 'Library/Keychains'),
      )
      const snapshot = await inventory(run.root, version.files)
      assert.equal(snapshot.complete, true)
      assert.ok(snapshot.files.every((file) => file.expected))
      assert.deepEqual(
        snapshot.files.map((file) => file.path).sort(),
        mdc
          ? ['work/.cursor/rules/artifactshare.mdc']
          : [
              'work/.cursor/skills/artifactshare/SKILL.md',
              'work/.cursor/skills/artifactshare/references/share.md',
            ],
      )
      await rm(join(run.env.agent.HOME, '.cursor/cli-config.json'))
      await writeFile(join(run.env.agent.HOME, '.cursor/cli-config.json'), '{}')
      await mkdir(join(run.env.agent.HOME, '.cursor/skills/artifactshare'), {
        recursive: true,
      })
      await writeFile(
        join(run.env.agent.HOME, '.cursor/skills/artifactshare/SKILL.md'),
        'unexpected',
      )
      const changed = await inventory(run.root, version.files)
      assert.ok(
        changed.files.some(
          (file) =>
            file.scope === 'user' &&
            file.location === 'cursor' &&
            !file.expected,
        ),
      )
    } finally {
      await run.cleanup()
    }
    await assert.rejects(access(run.root))
    assert.equal(await readFile(realConfig, 'utf8'), '{"fixture":true}')
    assert.equal((await stat(realConfig)).mtimeMs, before.mtimeMs)
  }
})

test('comments setup posts feedback and reports observations without grading them', async (t) => {
  const { executeCase, promptFor, commentText, expectedContent, initialHtml } =
    await import('./skill-eval.mjs')
  const { root, version } = await fixture(t)
  const url = 'http://localhost:5173/a/sample'
  const prompt = promptFor('comments', url)
  assert.match(prompt, /report\.html/u)
  assert.ok(prompt.includes(url))
  assert.doesNotMatch(
    prompt,
    /artifactshare|comments (?:list|post|resolve)|--json|--body|Launch is ready/iu,
  )
  assert.ok(commentText.includes(expectedContent))
  for (const observation of [
    'success',
    'nonzero',
    'error-envelope',
    'malformed',
    'missing-exit',
    'not-reply',
    'setup-error',
  ]) {
    const failPost = observation === 'setup-error'
    let run
    const commands = []
    const artifacts = new Map()
    const artifact = {
      id: 'sample',
      share_url: url,
      version_id: 'old',
      content: 'Draft schedule',
    }
    const result = await executeCase(
      {
        combination: 'cursor:grok-4.7-high',
        scenario: 'comments',
        version: version.label,
        command: ['fake-agent'],
      },
      { baseUrl: 'http://localhost:5173', timeoutMs: 1000, maxTurns: 2 },
      version,
      { target: join(root, 'unused'), files: version.files },
      {
        list: () => Promise.resolve([...artifacts.values()]),
        get: (id) => Promise.resolve({ ...artifacts.get(id) }),
        delete: (id) => Promise.resolve(artifacts.delete(id)),
      },
      'fixture-token',
      root,
      new AbortController().signal,
      {
        async createRun(options) {
          run = await createRun({ ...options, linkCredentials: false })
          return run
        },
        async runProcess(options) {
          commands.push(options.command)
          if (commands.length === 1) {
            assert.equal(
              await readFile(join(run.workdir, 'report.html'), 'utf8'),
              initialHtml,
            )
            artifacts.set('sample', artifact)
            return {
              status: 'completed',
              stdout: JSON.stringify({ data: { artifact } }),
              stderr: '',
            }
          }
          if (commands.length === 2) {
            assert.equal(options.env, run.env.agent)
            return failPost
              ? {
                  status: 'infrastructure-error',
                  stdout: '',
                  stderr: JSON.stringify({
                    error: { code: 'comment_rejected', message: 'Cannot post' },
                  }),
                }
              : { status: 'completed', stdout: '{}', stderr: '' }
          }
          assert.equal(options.prompt, prompt)
          artifacts.set('sample', {
            ...artifact,
            version_id: 'new',
            content: expectedContent,
          })
          await writeFile(
            run.config.log,
            [
              ['comments', 'list', url, '--json'],
              [
                'comments',
                'post',
                url,
                '--reply-to',
                'thread',
                '--body',
                'Done',
                '--json',
              ],
              ['comments', 'resolve', url, '--thread-id', 'thread', '--json'],
              ['update', url, 'report.html', '--json'],
            ]
              .map((argv) =>
                JSON.stringify({
                  argv,
                  exitCode:
                    observation === 'nonzero'
                      ? 1
                      : observation === 'missing-exit'
                        ? null
                        : 0,
                  stdout:
                    observation === 'malformed'
                      ? '{broken'
                      : JSON.stringify({
                          ok: observation !== 'error-envelope',
                          command: argv.slice(0, 2).join(' '),
                          data: { reply: observation !== 'not-reply' },
                        }),
                }),
              )
              .join('\n'),
          )
          return {
            status: 'completed',
            stdout: JSON.stringify({
              type: 'result',
              is_error: false,
              result: url,
            }),
            stderr: '',
            exitCode: 0,
          }
        },
      },
    )
    assert.deepEqual(commands[0].slice(1), [
      'share',
      'report.html',
      '--visibility',
      'private',
      '--json',
    ])
    assert.deepEqual(commands[1].slice(1), [
      'comments',
      'post',
      url,
      '--body',
      commentText,
      '--json',
    ])
    assert.equal(result.cleanup.temporary, true)
    assert.equal(artifacts.size, 0)
    if (failPost) {
      assert.equal(commands.length, 2)
      assert.equal(result.status, 'infrastructure-error')
      assert.match(result.error, /Comment post failed: comment_rejected/u)
    } else {
      assert.equal(result.status, 'completed')
      for (const check of ['content', 'identity', 'finalUrl', 'json'])
        assert.equal(result.checks[check].status, 'pass')
      assert.equal(result.comments.read, true)
      assert.equal(result.comments.replied, observation === 'success')
      assert.equal(
        result.comments.resolved,
        ['success', 'not-reply'].includes(observation),
      )
      assert.ok(
        !Object.keys(result.checks).some((key) => key.startsWith('comments')),
      )
    }
  }
})
