// The environment variable a worktree activity lock holder sets on the
// children it launches (the implementation and spec gates on their
// reviewers), so a child runs under its parent's lock instead of contending
// for it. Kept as a small module with no imports so any gate can load it
// without the lock primitive. The variable is inherited by the child's whole
// process subtree, so a lock-protected command started below a reviewer runs
// under the same lock.
export const ACTIVITY_LOCK_HELD_ENV = 'ARTIFACTSHARE_ACTIVITY_LOCK_HELD'

export function lockHeldByParent(env = process.env) {
  return env[ACTIVITY_LOCK_HELD_ENV] === '1'
}

export function withActivityLockHeld(env = process.env) {
  return { ...env, [ACTIVITY_LOCK_HELD_ENV]: '1' }
}
