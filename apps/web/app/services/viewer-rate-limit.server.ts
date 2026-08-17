export interface ViewerRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

const RETRY_AFTER_SECONDS = 60

export function isViewerRateLimitedPath(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let segments: string[]
  try {
    segments = new URL(request.url).pathname.split('/')
  } catch {
    return false
  }
  if (segments.at(-1) === '') segments.pop()
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
