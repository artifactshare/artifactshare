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
  await assert.rejects(
    runProvider(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 25,
    }),
    /timed out after 25ms/u,
  )
})
