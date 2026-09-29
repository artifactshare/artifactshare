import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  acquireFileLock,
  acquireLandingLock,
  LANDING_LOCK_TIMEOUT_MS,
  landingLockWaitingMessage,
} from './os-file-lock.mjs'

test('bounds release, terminates the holder, and reports the timeout', async () => {
  const signals = []
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = (signal = 'SIGTERM') => {
    signals.push(signal)
    if (signal === 'SIGKILL')
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('close', null)
      })
  }
  const releasePromise = acquireFileLock('/tmp/activity-test.lock', {
    platform: 'darwin',
    spawnProcess: () => child,
    releaseTimeoutMs: 10,
    terminateTimeoutMs: 10,
    setTimer: (callback, ms) => {
      if (ms === 10) queueMicrotask(callback)
    },
  })
  queueMicrotask(() => child.stdout.write('locked\n'))
  const release = await releasePromise
  await assert.rejects(release(), /Timed out after 10ms/u)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

for (const wait of [false, true]) {
  test(`terminates the holder before rejecting an explicit acquisition timeout (wait=${wait})`, async () => {
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
    await assert.rejects(
      acquireFileLock('/tmp/activity-acquire-test.lock', {
        wait,
        platform: 'darwin',
        spawnProcess: () => child,
        acquireTimeoutMs: 10,
        terminateTimeoutMs: 10,
        setTimer: (callback, ms) => {
          if (ms === 10) queueMicrotask(callback)
        },
      }),
      /Timed out while acquiring/u,
    )
    assert.equal(killed, true)
  })
}

test('settles an acquisition timeout when the wrapper exits before pipes close', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    child.exitCode = 0
  }
  await assert.rejects(
    acquireFileLock('/tmp/activity-wrapper-exit-test.lock', {
      platform: 'darwin',
      spawnProcess: () => child,
      acquireTimeoutMs: 10,
      terminateTimeoutMs: 10,
      setTimer: (callback, ms) => {
        if (ms === 10) queueMicrotask(callback)
      },
    }),
    /Timed out while acquiring/u,
  )
})

function fakeChild() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.finish = (code) => {
    child.exitCode = code
    child.emit('close', code)
  }
  child.stdin.on('finish', () => child.finish(0))
  child.kill = () => child.finish(0)
  return child
}

for (const platform of ['darwin', 'linux']) {
  test(`notifies once after actual contention and acquires after race: ${platform}`, async () => {
    const first = fakeChild()
    const second = fakeChild()
    const waiting = Promise.withResolvers()
    const spawned = Promise.withResolvers()
    const durations = []
    let attempts = 0
    let notices = 0
    let now = 0
    const result = acquireFileLock('/tmp/landing-race.lock', {
      wait: true,
      platform,
      acquireTimeoutMs: 600_000,
      now: () => now,
      setTimer: (_callback, ms) => {
        durations.push(ms)
      },
      onContention: () => {
        notices++
        waiting.resolve()
      },
      spawnProcess: (_file, args) => {
        attempts++
        if (attempts === 1) {
          assert.ok(args.includes(platform === 'darwin' ? '-t' : '-n'))
          return first
        }
        assert.ok(!args.includes(platform === 'darwin' ? '-t' : '-n'))
        spawned.resolve()
        return second
      },
    })
    assert.equal(notices, 0)
    now = 100
    first.finish(75)
    await waiting.promise
    await spawned.promise
    // Holder left between the immediate attempt and blocking acquisition.
    second.stdout.write('locked\n')
    const release = await result
    assert.equal(notices, 1)
    assert.deepEqual(durations, [600_000, 599_900])
    await release()
  })
}

test('immediate acquisition is quiet and non-contention failure never retries', async () => {
  for (const outcome of ['locked', 'failed', 'spawn']) {
    const child = fakeChild()
    let attempts = 0
    const pending = acquireFileLock('/tmp/landing-immediate.lock', {
      wait: true,
      onContention: assert.fail,
      spawnProcess: () => {
        attempts++
        return child
      },
      setTimer: () => {},
    })
    if (outcome === 'locked') {
      child.stdout.write('locked\n')
      await (
        await pending
      )()
    } else {
      if (outcome === 'spawn')
        child.emit(
          'error',
          Object.assign(new Error('missing utility'), { code: 'ENOENT' }),
        )
      else {
        child.stderr.write('permission denied')
        child.finish(73)
      }
      await assert.rejects(
        pending,
        (error) =>
          error.code === (outcome === 'spawn' ? 'ENOENT' : 'LOCK_FAILED'),
      )
    }
    assert.equal(attempts, 1)
  }
})

test('contended acquisition deadline terminates its child with bounded cleanup', async () => {
  const first = fakeChild()
  const second = fakeChild()
  const spawned = Promise.withResolvers()
  const timers = []
  const signals = []
  second.kill = (signal = 'SIGTERM') => {
    signals.push(signal)
  }
  let attempts = 0
  const pending = acquireFileLock('/tmp/landing-timeout.lock', {
    wait: true,
    acquireTimeoutMs: 600_000,
    onContention: () => {},
    setTimer: (callback, ms) => {
      timers.push({ callback, ms })
    },
    spawnProcess: () => {
      if (++attempts === 1) return first
      spawned.resolve()
      return second
    },
  })
  first.finish(75)
  await spawned.promise
  const rejected = assert.rejects(pending, { code: 'LOCK_TIMEOUT' })
  timers.at(-1).callback()
  assert.equal(timers.at(-1).ms, 1_000)
  timers.at(-1).callback()
  assert.equal(timers.at(-1).ms, 1_000)
  timers.at(-1).callback()
  await rejected
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('real platform lock reports contention as LOCK_BUSY', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'as-real-lock-'))
  const path = join(directory, 'landing.lock')
  let releaseHolder
  let releaseContender
  try {
    releaseHolder = await acquireFileLock(path)
    await assert.rejects(
      async () => {
        releaseContender = await acquireFileLock(path, { wait: false })
      },
      { code: 'LOCK_BUSY' },
    )
  } finally {
    try {
      await releaseContender?.()
    } finally {
      try {
        await releaseHolder?.()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
})

for (const timeoutMs of [undefined, 180_000]) {
  test(`landing timeout retains its budget, code, path and quoted holder lookup (${timeoutMs ?? 'default'})`, async () => {
    const expectedBudget = timeoutMs ?? LANDING_LOCK_TIMEOUT_MS
    const path = "/tmp/landing's lock"
    await assert.rejects(
      acquireLandingLock(path, {
        timeoutMs,
        acquireLock: (_path, options) => {
          assert.equal(options.acquireTimeoutMs, expectedBudget)
          throw Object.assign(new Error('timeout'), { code: 'LOCK_TIMEOUT' })
        },
      }),
      (error) => {
        assert.equal(error.code, 'LOCK_TIMEOUT')
        assert.equal(
          error.message,
          `Timed out after ${expectedBudget / 60_000} minutes waiting for the landing lock: ${path}. Find the holder with: lsof '/tmp/landing'\\''s lock'`,
        )
        return true
      },
    )
  })
}

test(
  'Ready and landing contend on the real shared OS lock across processes',
  {
    skip: !['darwin', 'linux'].includes(process.platform),
    timeout: 15_000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'as-shared-lock-'))
    const ledger = join(directory, 'ledger.json')
    const children = []
    const holders = []
    t.after(async () => {
      for (const pid of holders) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children.map((child) => child.closed))
      rmSync(directory, { recursive: true, force: true })
    })
    const source = `
    import { spawn } from 'node:child_process'
    import { runReady, parseArgs } from './scripts/pr-ready.mjs'
    import { landed } from './scripts/pr-landed.mjs'
    import { acquireFileLock } from './scripts/os-file-lock.mjs'
    const [role, ledger] = process.argv.slice(1)
    const releaseSignal = new Promise(resolve => process.once('message', resolve))
    const head = 'a'.repeat(40)
    let draft = true
    const exec = (file, args) => {
      if (file === 'gh' && args[1] === 'view') return JSON.stringify({ state: 'MERGED', headRefName: 'main' })
      if (file === 'gh' && args[1] === 'list') return JSON.stringify([{number: 56, isDraft: draft, baseRefName: 'main', headRefName: 'topic', headRefOid: head, isCrossRepository: false, body: 'Public body'}])
      if (file === 'gh' && args[1] === 'ready') draft = false
      if (file === 'git' && args[0] === 'branch') return 'topic'
      if (file === 'git' && args[0] === 'rev-parse') return head
      return ''
    }
    const acquireLock = async (path, options) => {
      const release = await acquireFileLock(path, { ...options, acquireTimeoutMs: 5000, spawnProcess: (...args) => {
        const child = spawn(...args)
        process.send({type: 'holder', pid: child.pid})
        return child
      } })
      return async () => {
        if (role === 'ready') {
          process.send({type: 'held'})
          await releaseSignal
        }
        await release()
      }
    }
    const log = line => process.send({type: 'log', line})
    try {
      const result = role === 'ready'
        ? await runReady({ledger, parsed: parseArgs(['--deferred', 'synthetic finding']), exec, acquireLock, log, reportError: line => { throw new Error(line) }})
        : await landed({ledger, parsed: {pr: 56, dryRun: false}, exec, acquireLock, log})
      process.send({type: 'done', result})
      process.disconnect()
    } catch (error) { console.error(error); process.exit(1) }
  `
    function start(role) {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', source, role, ledger],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      )
      const messages = []
      const updates = new EventEmitter()
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('message', (message) => {
        messages.push(message)
        if (message.type === 'holder') holders.push(message.pid)
        updates.emit('update')
      })
      child.closed = new Promise((resolve) =>
        child.once('close', (code) => {
          resolve(code)
          updates.emit('update')
        }),
      )
      child.wait = (type) =>
        new Promise((resolve, reject) => {
          const check = () => {
            const message = messages.find((row) => row.type === type)
            if (message) {
              updates.off('update', check)
              resolve(message)
            } else if (child.exitCode !== null || child.signalCode !== null) {
              updates.off('update', check)
              reject(new Error(stderr || 'Child exited before ' + type))
            }
          }
          updates.on('update', check)
          check()
        })
      child.messages = messages
      children.push(child)
      return child
    }
    const ready = start('ready')
    await ready.wait('held')
    const landing = start('landing')
    const waiting = await landing.wait('log')
    assert.equal(waiting.line, landingLockWaitingMessage(`${ledger}.lock`))
    assert.ok(!landing.messages.some((row) => row.type === 'done'))
    ready.send('release')
    assert.equal((await ready.wait('done')).result, 0)
    const result = (await landing.wait('done')).result
    assert.equal(result.exitCode, 0)
    assert.equal(result.releasedDeferred, 1)
    assert.equal(landing.messages.filter((row) => row.type === 'log').length, 1)
    assert.equal(await ready.closed, 0)
    assert.equal(await landing.closed, 0)
  },
)
