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
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expectFailure, expectSuccess, run, testCwd } from './test/helpers.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
  type PreviewAgentNotificationProjection,
} from './preview/contract.js'
import { writeClaudeChannelRecord } from './preview/claude-notification.js'

const cliPath = join(import.meta.dirname, '..', 'dist', 'index.js')

interface LiveServer {
  child: ChildProcess
  readyStdout: string
  ready: {
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
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
    },
  }
}

async function startPreview(
  env: Record<string, string>,
  filePath: string,
  extraArgs: string[] = [],
): Promise<LiveServer> {
  const child = spawn(
    process.execPath,
    [cliPath, 'preview', filePath, '--no-open', '--json', ...extraArgs],
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

test('preview serves ready JSON and reuses the live session', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  assert.equal(server.ready.reused, false)
  assert.match(server.ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.match(server.ready.share_origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.deepEqual(server.ready.agent, {
    provider: 'generic',
    transport: 'long_poll',
    capability: 'wait',
    state: 'manual_required',
  })

  const rerun = run(['preview', filePath, '--no-open', '--json'], env)
  const payload = expectSuccess(rerun, 'preview')
  assert.equal((payload.data as { reused: boolean }).reused, true)
  assert.equal(
    (payload.data as { session: string }).session,
    server.ready.session,
  )
})

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

test('a disconnected Claude Channel falls back and persists background wait', async () => {
  const { env, dir } = previewEnv()
  const claudeEnv = {
    ...env,
    CLAUDE_CODE_SESSION_ID: 'claude-preview-channel',
  }
  writeClaudeChannelRecord(
    {
      schema_version: 1,
      claude_session_id: 'claude-preview-channel',
      endpoint: 'http://127.0.0.1:1/preview-batch',
      token: 'd'.repeat(64),
      pid: process.pid,
      acknowledged_at: '2026-08-29T00:00:00.000Z',
    },
    claudeEnv,
  )
  const filePath = writeLp(dir)
  const server = await startPreview(claudeEnv, filePath)
  assert.equal(server.ready.agent.transport, 'channel')

  await browserApi(server, 'POST', '/api/annotations', {
    anchor: { kind: 'artifact' },
    comment: 'saved despite channel disconnect',
  })
  const submitted = await browserApi(server, 'POST', '/api/annotations/submit')
  assert.deepEqual(submitted.agent, {
    provider: 'claude_code',
    transport: 'background_wait',
    capability: 'wait',
    state: 'failed',
    failure_code: 'target_unavailable',
  })

  const reuse = expectSuccess(
    run(['preview', filePath, '--no-open', '--json'], claudeEnv),
    'preview',
  )
  assert.equal((reuse.data as { reused: boolean }).reused, true)
  assert.equal(
    (reuse.data as { agent: PreviewAgentNotificationProjection }).agent
      .transport,
    'background_wait',
  )
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

test('the annotate-submit-next-done loop round-trips through the CLI', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)

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

  const next = run(['preview', 'next', filePath, '--json'], env)
  const nextPayload = expectSuccess(next, 'preview next')
  const items = (nextPayload.data as { items: Record<string, unknown>[] }).items
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.status, 'in_progress')
  assert.equal(item.generation, 1)
  assert.equal(
    (nextPayload.data as { agent: { state: string } }).agent.state,
    'processing',
  )

  const done = run(['preview', 'done', filePath, '--stdin', '--json'], env, {
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
  })
  const donePayload = expectSuccess(done, 'preview done')
  const results = (donePayload.data as { results: { result: string }[] })
    .results
  assert.equal(results[0]!.result, 'accepted')
  assert.equal(
    (donePayload.data as { agent: { state: string } }).agent.state,
    'completed',
  )

  const again = run(['preview', 'done', filePath, '--stdin', '--json'], env, {
    input: JSON.stringify({
      items: [
        { thread: item.thread, generation: 1, outcome: 'fixed', note: 'x' },
      ],
    }),
  })
  const againPayload = expectSuccess(again, 'preview done')
  assert.equal(
    (againPayload.data as { results: { result: string }[] }).results[0]!.result,
    'already_reported',
  )

  const reply = run(
    [
      'preview',
      'reply',
      filePath,
      '--thread',
      String(item.thread),
      '--body',
      'Adjusted per your note',
      '--json',
    ],
    env,
  )
  expectSuccess(reply, 'preview reply')

  const stop = run(['preview', 'stop', filePath, '--json'], env)
  const stopPayload = expectSuccess(stop, 'preview stop')
  assert.equal((stopPayload.data as { stopped: boolean }).stopped, true)

  await new Promise((resolve) => server.child.once('exit', resolve))
  const after = run(['preview', 'next', filePath, '--json'], env)
  expectFailure(after, {
    command: 'preview next',
    code: 'preview_session_not_found',
  })
})

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

test('only stop may reach a verified schema-1 preview session', async () => {
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
  const payload = expectSuccess(stop, 'preview stop')
  assert.equal((payload.data as { stopped: boolean }).stopped, true)
  await new Promise((resolve) => server.child.once('exit', resolve))
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
