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
      if (code === 9 || code === 10 || code === 13) return true
      if (code < 32 || (code >= 0x7f && code <= 0x9f)) return false
      if (code === 0x061c || code === 0xfeff) return false
      if (code >= 0x200b && code <= 0x200f) return false
      if (code >= 0x202a && code <= 0x202e) return false
      if (code >= 0x2060 && code <= 0x206f) return false
      return true
    })
    .join('')
  if (sanitized.length <= MAX_PERMISSION_DISPLAY_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_PERMISSION_DISPLAY_LENGTH)}\n… (truncated)`
}
