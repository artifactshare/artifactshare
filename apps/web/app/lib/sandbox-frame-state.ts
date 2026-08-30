export function shouldStartLivenessCheck(
  event: 'visibilitychange' | 'pageshow',
  visibilityState: DocumentVisibilityState,
  pageShowPersisted = false,
): boolean {
  if (visibilityState !== 'visible') return false
  return event === 'visibilitychange' || pageShowPersisted
}

export function shouldAttemptAutomaticRecovery(
  completedAttempts: number,
  attemptLimit: number,
): boolean {
  return completedAttempts < attemptLimit
}

export function shouldStartLivenessProbe(
  startGeneration: number,
  currentGeneration: number,
): boolean {
  return startGeneration === currentGeneration
}

export function shouldAcceptNavigationResult(
  resultGeneration: number,
  currentGeneration: number,
): boolean {
  return resultGeneration === currentGeneration
}

export function shouldReportBlock(
  reportedGeneration: number | null,
  currentGeneration: number,
): boolean {
  return reportedGeneration !== currentGeneration
}

export function classifySandboxProbeResponse(
  status: number,
  marker: string | null,
  body: string,
  expectedMarker: string,
): 'reachable' | 'forbidden' | 'network-error' {
  if (status === 200 && marker === expectedMarker && body === expectedMarker)
    return 'reachable'
  return status === 403 ? 'forbidden' : 'network-error'
}
