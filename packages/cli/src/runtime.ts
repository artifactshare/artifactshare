// Keep this module dependency-free: unsupported runtimes must never load the
// command graph (including HTTP clients that require newer Node APIs).
export const MINIMUM_NODE_VERSION = '22.19.0'

export function isSupportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [, major, minor] = match.map(Number)
  return major! > 22 || (major === 22 && minor! >= 19)
}

export function checkRuntime(
  argv: string[],
  version = process.versions.node,
): boolean {
  if (isSupportedNode(version)) return true
  const message = `Node.js ${MINIMUM_NODE_VERSION} or newer is required; current version is ${version}.`
  const hint = `Upgrade Node.js to ${MINIMUM_NODE_VERSION} or newer, then retry.`
  const error = {
    code: 'unsupported_node_version',
    message,
    why: 'The current Node.js runtime is unsupported.',
    hint,
    agent_recoverable: false,
    requires_human: true,
    recovery: { kind: 'ask_human' },
    details: {
      required_version: MINIMUM_NODE_VERSION,
      current_version: version,
    },
  }
  const json =
    argv.includes('--json') ||
    process.env.CI === 'true' ||
    !process.stdout.isTTY
  process.stderr.write(
    json
      ? `${JSON.stringify({ schema_version: 2, ok: false, command: 'unknown', error }, null, 2)}\n`
      : `Error: ${message} ${hint}\n`,
  )
  process.exitCode = 1
  return false
}
