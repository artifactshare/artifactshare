import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { readClaudeChannelRecord } from './claude-notification.js'

const channelPath = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'claude-channel-entry.js',
)
const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function send(child: ChildProcess, message: unknown): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`)
}

function messageQueue(child: ChildProcess) {
  const queued: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []
  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      const message = JSON.parse(line) as unknown
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queued.push(message)
    }
  })
  return async (): Promise<unknown> => {
    if (queued.length > 0) return queued.shift()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('MCP response timed out')),
        5_000,
      )
      waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
}

test('Claude Channel requires startup and per-batch acknowledgements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifactshare-channel-'))
  directories.push(root)
  const env = {
    ...process.env,
    ARTIFACTSHARE_CONFIG_HOME: root,
    CLAUDE_CODE_SESSION_ID: 'claude-channel-test',
  }
  const child = spawn(process.execPath, [channelPath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const nextMessage = messageQueue(child)

  send(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1.0.0' },
    },
  })
  const initialized = (await nextMessage()) as Record<string, unknown>
  assert.equal(initialized.id, 1)
  send(child, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })

  const startup = (await nextMessage()) as {
    method: string
    params: { content: string; meta: { challenge: string } }
  }
  assert.equal(startup.method, 'notifications/claude/channel')
  assert.equal(startup.params.content, 'artifactshare.channel.challenge')
  assert.equal(readClaudeChannelRecord('claude-channel-test', env), null)

  send(child, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'artifactshare_preview_channel_ack',
      arguments: { challenge: startup.params.meta.challenge },
    },
  })
  const startupAck = (await nextMessage()) as Record<string, unknown>
  assert.equal(startupAck.id, 2)
  const record = readClaudeChannelRecord('claude-channel-test', env)
  assert.notEqual(record, null)

  const batchChallenge = '123e4567-e89b-42d3-a456-426614174000'
  const responsePromise = fetch(record!.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record!.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
      challenge: batchChallenge,
    }),
  })
  const batch = (await nextMessage()) as {
    method: string
    params: { content: string; meta: Record<string, string> }
  }
  assert.equal(batch.method, 'notifications/claude/channel')
  assert.equal(batch.params.content, 'preview.batch_ready')
  assert.deepEqual(batch.params.meta, {
    preview_session_id: '0123456789abcdef',
    batch_id: 'batch-1',
    challenge: batchChallenge,
  })
  send(child, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'artifactshare_preview_channel_ack',
      arguments: { challenge: batchChallenge },
    },
  })
  const batchAck = (await nextMessage()) as Record<string, unknown>
  assert.equal(batchAck.id, 3)
  const response = await responsePromise
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    acknowledged: true,
    challenge: batchChallenge,
  })

  child.stdin?.end()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Channel did not close with its MCP session')),
      5_000,
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  assert.equal(readClaudeChannelRecord('claude-channel-test', env), null)
})
