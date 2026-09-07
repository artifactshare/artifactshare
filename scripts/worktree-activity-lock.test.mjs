import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ACTIVITY_LOCK_HELD_ENV,
  acquireActivityLock,
  activityLockPath,
  lockHeldByParent,
  runUnderActivityLock,
} from './worktree-activity-lock.mjs'

test('derives one lock path per worktree under the shared git directory', () => {
  const run = (file, args) =>
    args[1] === '--show-toplevel' ? '/repo/feature' : '/repo/.git'
  const path = activityLockPath(run)
  assert.match(
    path,
    /^\/repo\/\.git\/artifactshare\/worktree-activity\/[0-9a-f]{16}\.lock$/u,
  )
  const other = activityLockPath((file, args) =>
    args[1] === '--show-toplevel' ? '/repo/other' : '/repo/.git',
  )
  assert.notEqual(path, other)
})

test('a second activity in the same worktree is refused until the first releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-lock-'))
  const run = (file, args) =>
    args[1] === '--show-toplevel' ? '/repo/feature' : dir
  const release = await acquireActivityLock('screen capture', { run, env: {} })
  try {
    await assert.rejects(
      acquireActivityLock('implementation gate', { run, env: {} }),
      /Cannot start implementation gate: another review, capture, or critique/u,
    )
  } finally {
    await release()
  }
  try {
    const again = await acquireActivityLock('implementation gate', {
      run,
      env: {},
    })
    await again()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // A failure that is not contention is reported as itself; only a held lock
  // becomes the contention message.
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      env: {},
      acquire: () => Promise.reject(new Error('spawn lockf ENOENT')),
    }),
    /^Error: spawn lockf ENOENT$/u,
  )
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      env: {},
      acquire: () => Promise.reject(new Error('EACCES: permission denied')),
    }),
    /EACCES/u,
  )
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      env: {},
      acquire: () =>
        Promise.reject(
          new Error('A spec review coordinator already holds the local lock.'),
        ),
    }),
    /Cannot start critique: another review, capture, or critique/u,
  )
})

test('a child launched by the lock holder runs under the parent lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-lock-'))
  const run = (file, args) =>
    args[1] === '--show-toplevel' ? '/repo/feature' : dir
  const release = await acquireActivityLock('implementation gate', {
    run,
    env: {},
  })
  try {
    assert.equal(lockHeldByParent({ [ACTIVITY_LOCK_HELD_ENV]: '1' }), true)
    assert.equal(lockHeldByParent({}), false)
    // The reviewer the gate spawns is not refused and releases nothing real.
    const inherited = await acquireActivityLock('claude review', {
      run,
      env: { [ACTIVITY_LOCK_HELD_ENV]: '1' },
    })
    await inherited()
    await assert.rejects(
      acquireActivityLock('claude review', { run, env: {} }),
      /Cannot start claude review/u,
    )
  } finally {
    await release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runUnderActivityLock parses first, locks only a real run, and always releases', async () => {
  const events = []
  const acquire = (activity) => {
    events.push(`acquire ${activity}`)
    return Promise.resolve(() => {
      events.push('release')
      return Promise.resolve()
    })
  }
  const stderr = { write: (line) => events.push(`stderr ${line.trim()}`) }
  // Help takes no lock.
  assert.equal(
    await runUnderActivityLock(
      'claude review',
      { parse: () => ({ help: true }), acquire, stderr },
      () => 0,
    ),
    0,
  )
  assert.deepEqual(events, [])
  // An argument error is reported as itself, without touching the lock.
  assert.equal(
    await runUnderActivityLock(
      'claude review',
      {
        parse: () => {
          throw new Error('unknown argument --bogus')
        },
        acquire,
        stderr,
      },
      () => 0,
    ),
    1,
  )
  assert.deepEqual(events, ['stderr unknown argument --bogus'])
  events.length = 0
  // A real run locks, and releases even when the review throws.
  assert.equal(
    await runUnderActivityLock(
      'codex review',
      { parse: () => ({}), acquire, stderr },
      () => {
        throw new Error('HEAD or worktree changed during review.')
      },
    ),
    1,
  )
  assert.deepEqual(events, [
    'acquire codex review',
    'release',
    'stderr HEAD or worktree changed during review.',
  ])
  events.length = 0
  assert.equal(
    await runUnderActivityLock(
      'codex review',
      { parse: () => ({}), acquire, stderr },
      () => 0,
    ),
    0,
  )
  assert.deepEqual(events, ['acquire codex review', 'release'])
})
