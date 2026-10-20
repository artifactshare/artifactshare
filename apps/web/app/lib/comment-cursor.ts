export type MessageBoundary = { createdAt: string; id: string }

export function messageCursor(
  threadId: string,
  boundary: MessageBoundary,
): string {
  return btoa(JSON.stringify([1, threadId, boundary.createdAt, boundary.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function parseMessageCursor(
  value: string,
  threadId: string,
): MessageBoundary | null {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null
  try {
    const decoded: unknown = JSON.parse(
      atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    )
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== 1 ||
      decoded[1] !== threadId
    )
      return null
    const [, , createdAt, id] = decoded
    if (
      typeof createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt ||
      typeof id !== 'string' ||
      !/^[\w-]{1,128}$/.test(id)
    )
      return null
    return { createdAt, id }
  } catch {
    return null
  }
}
