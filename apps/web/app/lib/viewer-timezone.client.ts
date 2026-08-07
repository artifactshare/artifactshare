const DEFAULT_BROWSER_TIME_ZONE = 'UTC'

export function getBrowserTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      DEFAULT_BROWSER_TIME_ZONE
    )
  } catch {
    return DEFAULT_BROWSER_TIME_ZONE
  }
}

export function timezoneSyncAction(
  current: string | null,
  desired: string,
): { writeCookie: boolean; revalidate: boolean } {
  if (current === desired) {
    return { writeCookie: false, revalidate: false }
  }
  return {
    writeCookie: true,
    revalidate: current !== null || desired !== DEFAULT_BROWSER_TIME_ZONE,
  }
}
