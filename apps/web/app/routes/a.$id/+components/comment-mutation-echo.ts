const COMMENT_MUTATION_ECHO_TTL_MS = 30_000
const COMMENT_MUTATION_ECHO_MAX_ENTRIES = 20

export type AppliedCommentMutationEchoes = Map<string, number>

export function rememberAppliedCommentMutationEcho(
  echoes: AppliedCommentMutationEchoes,
  clientMutationId: string,
  now = Date.now(),
): void {
  evictAppliedCommentMutationEchoes(echoes, now)
  echoes.set(clientMutationId, now + COMMENT_MUTATION_ECHO_TTL_MS)
  while (echoes.size > COMMENT_MUTATION_ECHO_MAX_ENTRIES) {
    const oldest = echoes.keys().next().value
    if (typeof oldest !== 'string') break
    echoes.delete(oldest)
  }
}

export function consumeAppliedCommentMutationEcho(
  echoes: AppliedCommentMutationEchoes,
  clientMutationId: string,
  now = Date.now(),
): boolean {
  evictAppliedCommentMutationEchoes(echoes, now)
  const expiresAt = echoes.get(clientMutationId)
  if (expiresAt === undefined) return false
  echoes.delete(clientMutationId)
  return expiresAt > now
}

function evictAppliedCommentMutationEchoes(
  echoes: AppliedCommentMutationEchoes,
  now: number,
): void {
  for (const [clientMutationId, expiresAt] of echoes) {
    if (expiresAt > now) continue
    echoes.delete(clientMutationId)
  }
}
