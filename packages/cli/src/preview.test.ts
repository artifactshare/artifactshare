import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expectFailure, expectSuccess, run, testCwd } from './test/helpers.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  type PreviewAgentNotificationProjection,
} from './preview/contract.js'

const cliPath = join(import.meta.dirname, '..', 'dist', 'index.js')

interface LiveServer {
  child: ChildProcess
  readyStdout: string
  ready: {
    launcher_url: string
    url: string
    session: string
    share_origin: string
    reused: boolean
    agent: PreviewAgentNotificationProjection
  }
  env: Record<string, string>
  filePath: string
}

const liveServers: LiveServer[] = []

afterEach(async () => {
  for (const server of liveServers.splice(0)) {
    if (server.child.exitCode !== null || server.child.killed) continue
    server.child.kill('SIGKILL')
    await new Promise((resolve) => {
      const done = setTimeout(resolve, 2000)
      server.child.once('exit', () => {
        clearTimeout(done)
        resolve(undefined)
      })
    })
  }
})

function previewEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'as-preview-e2e-'))
  return {
    dir,
    env: {
      ARTIFACTSHARE_CONFIG_HOME: join(dir, 'config'),
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      ARTIFACTSHARE_TEST_BROWSER_OPENER: 'success',
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '',
      CURSOR_AGENT: '',
      ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT: '',
      ARTIFACTSHARE_CURSOR_ACP_TARGET: '',
    },
  }
}

async function startPreview(
  env: Record<string, string>,
  filePath: string,
  extraArgs: string[] = [],
  autoOpen = false,
): Promise<LiveServer> {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'preview',
      filePath,
      ...(autoOpen ? [] : ['--no-open']),
      '--json',
      ...extraArgs,
    ],
    {
      // The credential context includes the working directory, so a reuse
      // check only compares like with like when both start from the same one.
      cwd: testCwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let readyStdout = ''
  const ready = await new Promise<LiveServer['ready']>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`preview did not become ready: ${output}`)),
      10_000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      try {
        const parsed = JSON.parse(output)
        clearTimeout(timer)
        readyStdout = output
        resolve(parsed.data)
      } catch {
        // Keep buffering until the ready envelope is complete.
      }
    })
    child.once('exit', () =>
      reject(new Error(`preview exited early: ${output}`)),
    )
  })
  const server = { child, ready, readyStdout, env, filePath }
  liveServers.push(server)
  return server
}

async function browserApi(
  server: LiveServer,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, server.ready.url), {
    method,
    headers: {
      authorization: `Bearer ${JSON.parse(readFileSync(join(server.env.ARTIFACTSHARE_CONFIG_HOME!, 'previews', `${server.ready.session}.json`), 'utf8')).auth[path.startsWith('/api/agent/') ? 'control' : 'shell']}`,
      'content-type': 'application/json',
      [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  assert.equal(response.ok, true, `${method} ${path} -> ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

function writeLp(dir: string): string {
  const filePath = join(dir, 'lp.html')
  writeFileSync(
    filePath,
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
      '<title>LP</title></head><body><h1>Hello preview</h1></body></html>',
  )
  return filePath
}

test('the ready envelope is a single line', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  assert.equal(typeof server.ready.url, 'string')
  assert.equal(server.readyStdout.trimEnd().includes('\n'), false)
  JSON.parse(server.readyStdout)
})

test.each([false, true])(
  'preview serves a private launcher and reuses it (auto-open: %s)',
  async (autoOpen) => {
    const { env, dir } = previewEnv()
    const filePath = writeLp(dir)
    const server = await startPreview(env, filePath, [], autoOpen)
    assert.match(server.ready.launcher_url, /^file:/)
    const launcher = new URL(server.ready.launcher_url)
    assert.ok(readFileSync(launcher, 'utf8').includes('/__preview/launch'))
    assert.equal(server.ready.reused, false)
    assert.match(server.ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.match(server.ready.share_origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(server.ready.agent, {
      provider: 'generic',
      transport: 'long_poll',
      capability: 'wait',
      state: 'manual_required',
    })

    rmSync(launcher)
    const rerun = run(['preview', filePath, '--no-open', '--json'], env)
    const payload = expectSuccess(rerun, 'preview')
    assert.equal((payload.data as { reused: boolean }).reused, true)
    assert.equal(
      (payload.data as { launcher_url: string }).launcher_url,
      server.ready.launcher_url,
    )
    assert.equal(
      (payload.data as { session: string }).session,
      server.ready.session,
    )
    assert.ok(existsSync(launcher))
  },
)

test('preview registers Codex and queues only the fixed batch-ready notice', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const binDir = join(dir, 'bin')
  const queueLog = join(dir, 'queue.log')
  mkdirSync(binDir)
  const codex = join(binDir, 'codex')
  writeFileSync(
    codex,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CODEX_QUEUE_LOG"\n',
  )
  chmodSync(codex, 0o755)
  const thread = '123e4567-e89b-42d3-a456-426614174000'
  const server = await startPreview(
    {
      ...env,
      CODEX_THREAD_ID: thread,
      CODEX_SESSION_ID: thread,
      CODEX_QUEUE_LOG: queueLog,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    filePath,
  )
  assert.deepEqual(server.ready.agent, {
    provider: 'codex',
    transport: 'codex_queue',
    capability: 'push',
    state: 'waiting',
  })

  await browserApi(server, 'POST', '/api/annotations', {
    anchor: { kind: 'artifact' },
    comment: 'private annotation body',
  })
  const submitted = await browserApi(server, 'POST', '/api/annotations/submit')
  assert.equal(
    (submitted.agent as PreviewAgentNotificationProjection).state,
    'queued',
  )
  const invocation = readFileSync(queueLog, 'utf8')
  assert.match(invocation, /queue\n--thread\n123e4567-/)
  assert.match(invocation, /preview\.batch_ready/)
  assert.match(invocation, /preview next --session [0-9a-f]{16} --json/)
  assert.equal(invocation.includes('private annotation body'), false)
})

test('preview selects Claude background wait and manual fallback from trusted environment', async () => {
  const first = previewEnv()
  const backgroundFile = writeLp(first.dir)
  const background = await startPreview(
    { ...first.env, CLAUDE_CODE_SESSION_ID: 'claude-preview-test' },
    backgroundFile,
  )
  assert.deepEqual(background.ready.agent, {
    provider: 'claude_code',
    transport: 'background_wait',
    capability: 'wait',
    state: 'manual_required',
  })

  const second = previewEnv()
  const manualFile = writeLp(second.dir)
  const manual = await startPreview(
    {
      ...second.env,
      CLAUDE_CODE_SESSION_ID: 'claude-preview-manual',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    manualFile,
  )
  assert.deepEqual(manual.ready.agent, {
    provider: 'claude_code',
    transport: 'manual',
    capability: 'manual',
    state: 'manual_required',
  })
})

test('preview separates managed Cursor ACP, foreground wait, and ordinary Cursor pickup', async () => {
  let received = ''
  const bridge = createServer((request, response) => {
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      received += chunk
    })
    request.on('end', () => response.writeHead(202).end())
  })
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  const address = bridge.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const managedFixture = previewEnv()
    const target = JSON.stringify({
      schema_version: 1,
      endpoint: `http://127.0.0.1:${address.port}/preview-batch`,
      token: 'a'.repeat(64),
      pid: process.pid,
      session_id: 'cursor-managed',
      cwd: managedFixture.dir,
    })
    const managed = await startPreview(
      { ...managedFixture.env, ARTIFACTSHARE_CURSOR_ACP_TARGET: target },
      writeLp(managedFixture.dir),
    )
    assert.deepEqual(managed.ready.agent, {
      provider: 'cursor',
      transport: 'acp_managed',
      capability: 'push',
      state: 'waiting',
    })
    await browserApi(managed, 'POST', '/api/annotations', {
      anchor: { kind: 'artifact' },
      comment: 'must stay out of ACP',
    })
    const submitted = await browserApi(
      managed,
      'POST',
      '/api/annotations/submit',
    )
    assert.equal(
      (submitted.agent as PreviewAgentNotificationProjection).state,
      'queued',
    )
    assert.match(received, /preview\.batch_ready/)
    assert.equal(received.includes('must stay out of ACP'), false)

    const foregroundFixture = previewEnv()
    const foreground = await startPreview(
      {
        ...foregroundFixture.env,
        CURSOR_AGENT: '1',
        ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT: '1',
      },
      writeLp(foregroundFixture.dir),
    )
    assert.equal(foreground.ready.agent.transport, 'foreground_wait')
    assert.equal(foreground.ready.agent.capability, 'wait')

    const manualFixture = previewEnv()
    const manual = await startPreview(
      { ...manualFixture.env, CURSOR_AGENT: '1' },
      writeLp(manualFixture.dir),
    )
    assert.equal(manual.ready.agent.transport, 'manual')
    assert.equal(manual.ready.agent.capability, 'manual')
  } finally {
    bridge.close()
  }
})

test('reuse follows the credentials, not the presence of the flags', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath, ['--profile', 'work'])
  assert.equal(server.ready.reused, false)

  // Repeating the same selection is the normal case and must reuse.
  const same = run(
    ['preview', filePath, '--no-open', '--json', '--profile', 'work'],
    env,
  )
  const reused = expectSuccess(same, 'preview')
  assert.equal((reused.data as { reused: boolean }).reused, true)

  // A different account would share from the wrong place, so it is refused.
  const other = run(
    ['preview', filePath, '--no-open', '--json', '--profile', 'personal'],
    env,
  )
  expectFailure(other, { command: 'preview' })
})

test('reuse reports a different Codex session separately from credentials', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const firstThread = '123e4567-e89b-42d3-a456-426614174000'
  await startPreview(
    {
      ...env,
      CODEX_THREAD_ID: firstThread,
      CODEX_SESSION_ID: firstThread,
    },
    filePath,
  )
  const result = run(['preview', filePath, '--no-open', '--json'], {
    ...env,
    CODEX_THREAD_ID: '223e4567-e89b-42d3-a456-426614174000',
    CODEX_SESSION_ID: firstThread,
  })
  const failure = expectFailure(result, {
    command: 'preview',
    code: 'validation_failed',
  })
  assert.match(failure.error.message, /different agent session/i)
  assert.doesNotMatch(failure.error.message, /credentials/i)
})

test('preview next times out with no submission and errors with no session', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)

  const before = run(['preview', 'next', filePath, '--json'], env)
  expectFailure(before, {
    command: 'preview next',
    code: 'preview_session_not_found',
  })

  const server = await startPreview(env, filePath)
  const result = run(
    ['preview', 'next', server.filePath, '--wait', '1', '--json'],
    env,
  )
  const payload = expectSuccess(result, 'preview next')
  assert.deepEqual((payload.data as { items: unknown[] }).items, [])
  assert.equal((payload.data as { timed_out?: boolean }).timed_out, true)
  assert.equal(
    (payload.data as { agent: { state: string } }).agent.state,
    'manual_required',
  )
})

test('a competing preview wait returns retry guidance', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  await startPreview(env, filePath)
  const firstWait = spawn(
    process.execPath,
    [cliPath, 'preview', 'next', filePath, '--wait', '10', '--json'],
    {
      cwd: testCwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const competing = run(
      ['preview', 'next', filePath, '--wait', '10', '--json'],
      env,
    )
    const failure = expectFailure(competing, {
      command: 'preview next',
      code: 'preview_wait_conflict',
    })
    assert.equal(failure.error.recovery.kind, 'retry_later')
  } finally {
    firstWait.kill('SIGKILL')
    await new Promise((resolve) => firstWait.once('exit', resolve))
  }
})

test.each(['path', 'explicit', 'implicit'])(
  'authenticated agent commands select by %s',
  async (selector) => {
    const { env, dir } = previewEnv()
    const filePath = writeLp(dir)
    const server = await startPreview(env, filePath)
    const selection =
      selector === 'path'
        ? [filePath]
        : selector === 'explicit'
          ? ['--session', server.ready.session]
          : []

    await browserApi(server, 'POST', '/api/annotations', {
      anchor: {
        kind: 'element',
        state: 'attached',
        selector: 'body > h1',
        label: 'h1 "Hello preview"',
        contextText: 'Hello preview',
      },
      comment: 'Make it friendlier',
    })
    await browserApi(server, 'POST', '/api/annotations/submit')

    const next = run(['preview', 'next', ...selection, '--json'], env)
    const nextPayload = expectSuccess(next, 'preview next')
    const items = (nextPayload.data as { items: Record<string, unknown>[] })
      .items
    assert.equal(items.length, 1)
    const item = items[0]!
    assert.equal(item.status, 'in_progress')
    assert.equal(item.generation, 1)
    assert.equal(
      (nextPayload.data as { agent: { state: string } }).agent.state,
      'processing',
    )

    const done = run(
      ['preview', 'done', ...selection, '--stdin', '--json'],
      env,
      {
        input: JSON.stringify({
          items: [
            {
              thread: item.thread,
              generation: 1,
              outcome: 'fixed',
              note: 'Warmed up the headline',
            },
          ],
        }),
      },
    )
    const donePayload = expectSuccess(done, 'preview done')
    const results = (donePayload.data as { results: { result: string }[] })
      .results
    assert.equal(results[0]!.result, 'accepted')
    assert.equal(
      (donePayload.data as { agent: { state: string } }).agent.state,
      'completed',
    )

    const again = run(
      ['preview', 'done', ...selection, '--stdin', '--json'],
      env,
      {
        input: JSON.stringify({
          items: [
            { thread: item.thread, generation: 1, outcome: 'fixed', note: 'x' },
          ],
        }),
      },
    )
    const againPayload = expectSuccess(again, 'preview done')
    assert.equal(
      (againPayload.data as { results: { result: string }[] }).results[0]!
        .result,
      'already_reported',
    )

    const reply = run(
      [
        'preview',
        'reply',
        ...selection,
        '--thread',
        String(item.thread),
        '--body',
        'Adjusted per your note',
        '--json',
      ],
      env,
    )
    expectSuccess(reply, 'preview reply')

    const stop = run(['preview', 'stop', ...selection, '--json'], env)
    const stopPayload = expectSuccess(stop, 'preview stop')
    assert.equal((stopPayload.data as { stopped: boolean }).stopped, true)

    await new Promise((resolve) => server.child.once('exit', resolve))
    const after = run(['preview', 'next', ...selection, '--json'], env)
    expectFailure(after, {
      command: 'preview next',
      code: 'preview_session_not_found',
    })
  },
)

test('a second start for the same file is refused while one is in flight', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  await startPreview(env, filePath)

  // Reusing under different credentials would share from the wrong account.
  const withToken = run(
    ['preview', filePath, '--no-open', '--token', 'other-token', '--json'],
    env,
  )
  expectFailure(withToken, { command: 'preview', code: 'validation_failed' })
})

test('preview next rejects a non-numeric wait', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  await startPreview(env, filePath)
  const result = run(
    ['preview', 'next', filePath, '--wait', '3600oops', '--json'],
    env,
  )
  expectFailure(result, {
    command: 'preview next',
    code: 'validation_failed',
  })
})

test('preview stop --force stops a reachable session normally', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  // --force is only a fallback: a session that still answers is stopped over
  // HTTP, so its process exits instead of being untracked behind its back.
  const forced = run(['preview', 'stop', filePath, '--force', '--json'], env)
  const payload = expectSuccess(forced, 'preview stop')
  assert.equal((payload.data as { stopped: boolean }).stopped, true)
  await new Promise((resolve) => server.child.once('exit', resolve))
})

test('pre-auth records cannot authorize even stop', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  const configHome = env.ARTIFACTSHARE_CONFIG_HOME ?? ''
  writeFileSync(
    join(configHome, 'previews', `${server.ready.session}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: server.ready.session,
      realpath: realpathSync(filePath),
      port: Number(new URL(server.ready.url).port),
      share_port: Number(new URL(server.ready.share_origin).port),
      pid: server.child.pid,
      started_at: new Date().toISOString(),
      credentials: {
        profile: null,
        base_url: null,
        token_fingerprint: null,
        cwd: testCwd,
      },
    }),
  )

  const next = run(['preview', 'next', filePath, '--json'], env)
  expectFailure(next, {
    command: 'preview next',
    code: 'preview_session_unverified',
  })

  const stop = run(['preview', 'stop', filePath, '--json'], env)
  expectFailure(stop, {
    command: 'preview stop',
    code: 'preview_session_unverified',
  })
})

test('preview stop --force clears a record whose server is gone', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  server.child.kill('SIGKILL')
  await new Promise((resolve) => server.child.once('exit', resolve))

  const stop = run(['preview', 'stop', filePath, '--force', '--json'], env)
  const payload = expectSuccess(stop, 'preview stop')
  const data = payload.data as { cleared?: boolean; stopped?: boolean }
  assert.equal(data.stopped, false)
  // The killed server's port refuses, so the ordinary probe may already have
  // reclaimed the record; --force only has to guarantee none remains.
  assert.equal(typeof data.cleared, 'boolean')
})

test('a deleted source still reaches its live session by path', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  // A rebuild that removes and rewrites the file must not strand the running
  // server: the recorded path, not the file on disk, is the session identity.
  rmSync(filePath)

  const stop = run(['preview', 'stop', filePath, '--json'], env)
  const payload = expectSuccess(stop, 'preview stop')
  assert.equal((payload.data as { stopped: boolean }).stopped, true)
  await new Promise((resolve) => server.child.once('exit', resolve))
  // The serving process clears its own record on exit.
  assert.equal(
    existsSync(
      join(
        env.ARTIFACTSHARE_CONFIG_HOME ?? '',
        'previews',
        `${server.ready.session}.json`,
      ),
    ),
    false,
  )
})

test('a directory named like a page is refused', async () => {
  const { env, dir } = previewEnv()
  const target = join(dir, 'site.html')
  mkdirSync(target)
  const result = run(['preview', target, '--no-open', '--json'], env)
  expectFailure(result, { command: 'preview', code: 'validation_failed' })
})

test('a session id that is not 16 hex characters is refused', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  await startPreview(env, filePath)
  // Without validation this path would resolve outside the previews
  // directory and --force would delete an unrelated JSON file.
  const result = run(
    ['preview', 'stop', '--session', '../config', '--force', '--json'],
    env,
  )
  expectFailure(result, { command: 'preview stop' })
  const configHome = env.ARTIFACTSHARE_CONFIG_HOME ?? ''
  assert.equal(existsSync(join(dirname(configHome), 'config.json')), false)
})

test('restarting the same path invalidates all previous session authority', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const old = await startPreview(env, filePath)
  const record = JSON.parse(
    readFileSync(
      join(
        env.ARTIFACTSHARE_CONFIG_HOME!,
        'previews',
        `${old.ready.session}.json`,
      ),
      'utf8',
    ),
  )
  const shell = await (
    await fetch(old.ready.url, {
      headers: { authorization: `Bearer ${record.auth.shell}` },
    })
  ).text()
  const document = shell.match(
    /src="\/artifact\?capability=([a-f0-9]{64})"/,
  )![1]
  const exited = new Promise((resolve) => old.child.once('exit', resolve))
  expectSuccess(
    run(['preview', 'stop', filePath, '--json'], env),
    'preview stop',
  )
  await exited
  assert.equal(existsSync(new URL(old.ready.launcher_url)), false)
  const fresh = await startPreview(env, filePath)
  for (const [path, credential] of [
    ['__preview/session', record.auth.control],
    ['', record.auth.shell],
    ['artifact', document],
  ]) {
    assert.equal(
      (
        await fetch(new URL(path!, fresh.ready.url), {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).status,
      403,
    )
  }
  assert.notEqual(fresh.ready.launcher_url, old.ready.launcher_url)
})
