export function isSqliteConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code =
    typeof err.cause === 'object' && err.cause !== null
      ? Reflect.get(err.cause, 'code')
      : Reflect.get(err, 'code')
  const messages = [err.message]
  if (err.cause instanceof Error) messages.push(err.cause.message)
  return (
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    messages.some((message) => /constraint|unique|primary key/i.test(message))
  )
}
