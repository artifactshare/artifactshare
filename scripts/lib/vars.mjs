export function parseVarsFile(content) {
  const env = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (isQuoted) {
      value = value.slice(1, -1)
    } else {
      // Strip a trailing inline comment (whitespace-preceded #), matching how
      // wrangler's dotenv reader treats .dev.vars — otherwise a "# rotated"
      // note would be kept as part of the key and fail deep in a Stripe call.
      const commentIndex = value.search(/\s#/)
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trimEnd()
    }
    env[key] = value
  }
  return env
}
