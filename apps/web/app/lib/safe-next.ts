/**
 * A post-login / post-action redirect target, constrained to an internal path
 * so an attacker-controlled `next` value can't bounce the user to another
 * origin. Accepts whatever a query param or form field yields.
 */
export function safeInternalNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/'
  // `//host` and `/\host` start with `/` but browsers resolve them to another
  // origin, so reject those as well — only a true single-slash path is internal.
  if (next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

export function hasSafeInternalNext(rawNext: string | null): boolean {
  return rawNext !== null && safeInternalNext(rawNext) === rawNext
}

export function hasSafeArtifactInviteNext(rawNext: string | null): boolean {
  return (
    rawNext !== null &&
    hasSafeInternalNext(rawNext) &&
    rawNext.startsWith('/a/')
  )
}
