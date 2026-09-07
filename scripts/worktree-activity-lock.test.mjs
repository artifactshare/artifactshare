import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  acquireActivityLock,
  activityLockPath,
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
  const release = await acquireActivityLock('screen capture', { run })
  try {
    await assert.rejects(
      acquireActivityLock('implementation gate', { run }),
      /Cannot start implementation gate: another review, capture, or critique/u,
    )
  } finally {
    await release()
  }
  try {
    const again = await acquireActivityLock('implementation gate', { run })
    await again()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // A failure that is not contention is reported as itself; only a held lock
  // becomes the contention message.
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      acquire: () => Promise.reject(new Error('spawn lockf ENOENT')),
    }),
    /^Error: spawn lockf ENOENT$/u,
  )
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      acquire: () => Promise.reject(new Error('EACCES: permission denied')),
    }),
    /EACCES/u,
  )
  await assert.rejects(
    acquireActivityLock('critique', {
      run,
      acquire: () =>
        Promise.reject(
          new Error('A spec review coordinator already holds the local lock.'),
        ),
    }),
    /Cannot start critique: another review, capture, or critique/u,
  )
})
