/**
 * A log-safe description of why one indexed file failed. Error messages can
 * quote file contents (a JSON or HTML parse error, for example), so only the
 * error's name and a message that is one of our own identifier-shaped codes,
 * or a leading D1/SQLite error code, are kept.
 */
export function searchFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const message = error.message
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(message)) return `${error.name}:${message}`
  const code = /^(?:D1_[A-Z_]+|SQLITE_[A-Z_]+)/u.exec(message)?.[0]
  return code ? `${error.name}:${code}` : error.name
}
