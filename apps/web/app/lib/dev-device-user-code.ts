// Stable eight-character codes for isolated publisher screen workspaces.
export function devPublisherUserCode(workspaceId: string): string {
  let hash = 0x811c9dc5
  for (const char of workspaceId) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').toUpperCase()
}
