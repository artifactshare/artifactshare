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
  try {
    const release = await acquireActivityLock('screen capture', { run })
    await assert.rejects(
      acquireActivityLock('implementation gate', { run }),
      /Cannot start implementation gate: another review, capture, or critique/u,
    )
    await release()
    const again = await acquireActivityLock('implementation gate', { run })
    await again()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
