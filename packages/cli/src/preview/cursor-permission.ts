const MAX_PERMISSION_DISPLAY_LENGTH = 12_000

export function formatCursorPermissionRequest(toolCall: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(toolCall ?? {}, null, 2)
  } catch {
    serialized = String(toolCall)
  }
  const sanitized = [...serialized]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      )
    })
    .join('')
  if (sanitized.length <= MAX_PERMISSION_DISPLAY_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_PERMISSION_DISPLAY_LENGTH)}\n… (truncated)`
}
