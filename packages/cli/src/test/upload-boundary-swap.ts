import assert from 'node:assert/strict'
import { lstat, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { UploadBoundaryHooks } from '../upload-boundary.js'

/** Real substitutions; fixture errors are checked outside the boundary's catch. */
export function uploadBoundarySwap({
  phase,
  parent,
  selected,
  external,
  path,
}: {
  phase: 'enumerated' | 'before-open' | 'opened' | 'read'
  parent: boolean
  selected: string
  external: string
  path: string
}) {
  const victim = parent ? selected : path
  let changed = false
  let blockedByOpenHandle = false
  let fixtureError: unknown
  async function substitute() {
    await rename(victim, `${victim}.old`)
    await symlink(
      parent ? external : join(external, 'index.html'),
      victim,
      parent ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file',
    )
    changed = true
  }
  const checkpoint: NonNullable<UploadBoundaryHooks['checkpoint']> = async (
    point,
  ) => {
    if (point !== phase || changed || blockedByOpenHandle) return
    const before = await lstat(victim, { bigint: true })
    try {
      try {
        await substitute()
      } catch (error) {
        // Windows can deny renaming a parent while its child handle is open.
        // Only this exact native denial is an alternate outcome; all other
        // fixture failures must fail the test, even if the boundary wraps them.
        if (
          process.platform !== 'win32' ||
          (phase !== 'opened' && phase !== 'read') ||
          !parent ||
          !['EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        const after = await lstat(victim, { bigint: true })
        assert.equal(after.isSymbolicLink(), false)
        assert.equal(after.dev, before.dev)
        assert.equal(after.ino, before.ino)
        blockedByOpenHandle = true
        throw new Error(
          'Windows refused the parent rename with an open child handle',
        )
      }
    } catch (error) {
      if (!blockedByOpenHandle) fixtureError = error
      throw error
    }
  }
  return {
    checkpoint,
    async assertCompleted() {
      assert.ifError(fixtureError)
      if (blockedByOpenHandle) {
        // The caller has finished and closed the handle. Prove that the same
        // substitution now succeeds, rather than accepting a broken fixture.
        assert.equal(changed, false)
        await substitute()
      }
      assert.equal(changed, true, 'substitution must actually complete')
      assert.equal((await lstat(victim)).isSymbolicLink(), true)
      return blockedByOpenHandle
    },
  }
}
