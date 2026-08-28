import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { expectFailure, expectSuccess, run } from './test/helpers.js'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
} from './preview/contract.js'

const cliPath = join(import.meta.dirname, '..', 'dist', 'index.js')

interface LiveServer {
  child: ChildProcess
  ready: {
    url: string
    session: string
    share_origin: string
    reused: boolean
  }
  env: Record<string, string>
  filePath: string
}

const liveServers: LiveServer[] = []

afterEach(async () => {
  for (const server of liveServers.splice(0)) {
    if (server.child.exitCode !== null) continue
    server.child.kill('SIGKILL')
    await new Promise((resolve) => server.child.once('exit', resolve))
  }
})

function previewEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'as-preview-e2e-'))
  return {
    dir,
    env: {
      ARTIFACTSHARE_CONFIG_HOME: join(dir, 'config'),
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    },
  }
}

async function startPreview(
  env: Record<string, string>,
  filePath: string,
): Promise<LiveServer> {
  const child = spawn(
    process.execPath,
    [cliPath, 'preview', filePath, '--no-open', '--json'],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
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
        resolve(parsed.data)
      } catch {
        // Keep buffering until the ready envelope is complete.
      }
    })
    child.once('exit', () =>
      reject(new Error(`preview exited early: ${output}`)),
    )
  })
  const server = { child, ready, env, filePath }
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

test('preview serves ready JSON and reuses the live session', async () => {
  const { env, dir } = previewEnv()
  const filePath = writeLp(dir)
  const server = await startPreview(env, filePath)
  assert.equal(server.ready.reused, false)
  assert.match(server.ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.match(server.ready.share_origin, /^http:\/\/127\.0\.0\.1:\d+$/)

  const rerun = run(['preview', filePath, '--no-open', '--json'], env)
  const payload = expectSuccess(rerun, 'preview')
  assert.equal((payload.data as { reused: boolean }).reused, true)
  assert.equal(
    (payload.data as { session: string }).session,
    server.ready.session,
  )
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
  const items = (nextPayload.data as { items: Record<string, unknown>[] })
    .items
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.status, 'in_progress')
  assert.equal(item.generation, 1)

  const done = run(
    ['preview', 'done', filePath, '--stdin', '--json'],
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
  const results = (
    donePayload.data as { results: { result: string }[] }
  ).results
  assert.equal(results[0]!.result, 'accepted')

  const again = run(
    ['preview', 'done', filePath, '--stdin', '--json'],
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
