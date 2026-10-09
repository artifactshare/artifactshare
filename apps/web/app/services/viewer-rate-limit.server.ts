export interface ViewerRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

const RETRY_AFTER_SECONDS = 60

export function isViewerRateLimitedPath(request: Request): boolean {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return false
  }
  const segments = pathname.split('/')
  while (segments.at(-1) === '') segments.pop()
  if (request.method === 'POST') {
    if (
      segments[0] !== '' ||
      decodeSegment(segments[1]) !== 'api' ||
      decodeSegment(segments[2]) !== 'shareables' ||
      !segments[3]
    ) {
      return false
    }
    const action = decodeSegment(segments[4])
    return (
      segments.length === 5 && (action === 'report' || action === 'report.data')
    )
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  // Strip the single-fetch suffix before normalizing route segments, just as
  // routing does for both current-version.data and current-version/.data.
  const routePathname = pathname.endsWith('.data')
    ? pathname.slice(0, -'.data'.length)
    : pathname
  const routeSegments = routePathname
    .split('/')
    .filter(Boolean)
    .map(decodeSegment)
  // Single fetch uses _.data when the page URL ends with a slash.
  if (pathname.endsWith('.data') && routeSegments.at(-1) === '_') {
    routeSegments.pop()
  }
  if (
    routeSegments.length === 4 &&
    routeSegments[0]?.toLowerCase() === 'api' &&
    routeSegments[1]?.toLowerCase() === 'shareables' &&
    routeSegments[2] &&
    routeSegments[3]?.toLowerCase() === 'current-version'
  )
    return true
  if (decodeSegment(segments.at(-1))?.toLowerCase() === '_.data') {
    segments.pop()
    while (segments.at(-1) === '') segments.pop()
  }
  if (segments[0] !== '' || decodeSegment(segments[1]) !== 'a') return false
  if (!segments[2]) return false
  return (
    segments.length === 3 ||
    (segments.length === 4 && decodeSegment(segments[3]) === 'og-image')
  )
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export async function checkViewerRateLimit(
  request: Request,
  limiter: ViewerRateLimiter | undefined,
): Promise<Response | null> {
  const clientIp = request.headers.get('cf-connecting-ip')
  if (!clientIp || !limiter) return null

  try {
    const { success } = await limiter.limit({ key: clientIp })
    if (success) return null
  } catch (error) {
    console.error('viewer_rate_limit_failed', { error })
    return null
  }

  return new Response(request.method === 'HEAD' ? null : 'Not found', {
    status: 429,
    headers: {
      'cache-control': 'private, no-store',
      'retry-after': String(RETRY_AFTER_SECONDS),
    },
  })
}
