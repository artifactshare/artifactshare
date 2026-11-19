import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Codex configuration for a reviewer whose filesystem is read-only except for
// one empty directory owned by a single invocation. A shell here-document
// needs a temporary file (zsh writes it under TMPPREFIX, /tmp/zsh by
// default), which `--sandbox read-only` refuses, so the reviewer's command
// stops. No path is denied: a denied ancestor also refuses the lstat that
// resolving TMPDIR needs (for example Node's fs.realpathSync). The network
// stays closed unless the caller opens it for the same profile.
export function codexShellSandboxArgs(profile, writableDirectory) {
  if (!/^[a-z][a-z0-9_-]*$/u.test(profile ?? ''))
    throw new Error('A Codex permission profile name is required.')
  if (!writableDirectory)
    throw new Error('Codex requires a shell temporary directory.')
  const writable = JSON.stringify(writableDirectory)
  return [
    '-c',
    `default_permissions=${JSON.stringify(profile)}`,
    '-c',
    `permissions.${profile}.filesystem={":root"="read",${writable}="write"}`,
    // Dotted keys keep any other shell_environment_policy.set entries from the
    // maintainer's Codex configuration.
    '-c',
    `shell_environment_policy.set.TMPDIR=${writable}`,
    '-c',
    `shell_environment_policy.set.TMPPREFIX=${JSON.stringify(join(writableDirectory, 'zsh'))}`,
  ]
}

// Creates an empty private directory for one invocation, runs `body` with it,
// and removes it afterwards, whether `body` succeeds or fails. The path is
// resolved so the sandbox rule names the same path the kernel checks (macOS
// tmpdir() is under the /var symlink).
export async function withShellTemporaryDirectory(prefix, body) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix))
  try {
    return await body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
