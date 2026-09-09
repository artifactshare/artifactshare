import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { acquireFileLock } from './os-file-lock.mjs'

test('bounds release, terminates the holder, and reports the timeout', async () => {
  let killed = false
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    killed = true
    queueMicrotask(() => {
      child.signalCode = 'SIGTERM'
      child.emit('close', null)
    })
  }
  const releasePromise = acquireFileLock('/tmp/activity-test.lock', {
    platform: 'darwin',
    spawnProcess: () => child,
    releaseTimeoutMs: 10,
    terminateTimeoutMs: 10,
  })
  queueMicrotask(() => child.stdout.write('locked\n'))
  const release = await releasePromise
  await assert.rejects(release(), /Timed out after 10ms/u)
  assert.equal(killed, true)
})
