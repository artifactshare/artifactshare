import assert from 'node:assert/strict'
import test from 'node:test'
import { runProvider } from './provider-process.mjs'

test('captures provider streams without writing shared process output', async () => {
  const result = await runProvider(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('answer'); process.stderr.write('progress') })",
    ],
    { input: 'request' },
  )
  assert.deepEqual(result, { stdout: 'answer', stderr: 'progress', code: 0 })
})

test('terminates and awaits a provider that exceeds its deadline', async () => {
  const started = Date.now()
  await assert.rejects(
    runProvider(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 50, terminateTimeoutMs: 50 },
    ),
    /timed out after 50ms/u,
  )
  assert.ok(Date.now() - started < 500)
})

test('rejects an early provider exit without an unhandled stdin error', async () => {
  await assert.rejects(
    runProvider(process.execPath, ['-e', 'process.exit(3)'], {
      input: 'x'.repeat(5 * 1024 * 1024),
      terminateTimeoutMs: 25,
    }),
    /EPIPE|write/u,
  )
})

test('retains only a bounded UTF-8-safe stderr tail', async () => {
  const result = await runProvider(process.execPath, [
    '-e',
    "process.stderr.write('前'.repeat(10000))",
  ])
  assert.match(result.stderr, /^\[earlier output omitted\]\n/u)
  assert.ok(Buffer.byteLength(result.stderr) < 9 * 1024)
  assert.doesNotMatch(result.stderr, /�/u)
})

test('does not mutate a shared abort reason', async () => {
  const controller = new AbortController()
  const reason = new Error('stop both')
  const running = runProvider(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal: controller.signal, terminateTimeoutMs: 25 },
  )
  controller.abort(reason)
  await assert.rejects(running, /stop both/u)
  assert.deepEqual(Object.keys(reason), [])
})
