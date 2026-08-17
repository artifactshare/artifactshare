import { describe, expect, test, vi } from 'vitest'
import {
  checkViewerRateLimit,
  isViewerRateLimitedPath,
  type ViewerRateLimiter,
} from './viewer-rate-limit.server'

describe('checkViewerRateLimit', () => {
  test('uses the Cloudflare client IP as the counter key', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true })
    const response = await checkViewerRateLimit(
      request('GET', '203.0.113.10'),
      { limit },
    )

    expect(response).toBeNull()
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.10' })
  })

  test('returns a non-cacheable 429 without artifact details', async () => {
    const response = await checkViewerRateLimit(
      request('GET', '203.0.113.10'),
      denyLimiter(),
    )

    expect(response?.status).toBe(429)
    expect(response?.headers.get('retry-after')).toBe('60')
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    await expect(response?.text()).resolves.toBe('Not found')
  })

  test('returns no body for a rate-limited HEAD request', async () => {
    const response = await checkViewerRateLimit(
      request('HEAD', '203.0.113.10'),
      denyLimiter(),
    )

    expect(response?.status).toBe(429)
    await expect(response?.text()).resolves.toBe('')
  })

  test('disables the limit when the binding or Cloudflare IP is absent', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false })

    await expect(
      checkViewerRateLimit(request('GET', null), { limit }),
    ).resolves.toBeNull()
    await expect(
      checkViewerRateLimit(request('GET', '203.0.113.10'), undefined),
    ).resolves.toBeNull()
    expect(limit).not.toHaveBeenCalled()
  })

  test('fails open and logs without request credentials', async () => {
    const error = new Error('binding unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const limiter: ViewerRateLimiter = {
      limit: vi.fn().mockRejectedValue(error),
    }

    await expect(
      checkViewerRateLimit(request('GET', '203.0.113.10'), limiter),
    ).resolves.toBeNull()
    expect(consoleError).toHaveBeenCalledWith('viewer_rate_limit_failed', {
      error,
    })
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('/a/')
    consoleError.mockRestore()
  })
})

describe('isViewerRateLimitedPath', () => {
  test.each([
    ['GET', '/a/example'],
    ['HEAD', '/a/example'],
    ['GET', '/a/example/og-image'],
    ['HEAD', '/a/example/og-image/'],
    ['GET', '/%61/example'],
    ['GET', '/a/example/%6fg-image'],
    ['GET', '/a/example%ZZ'],
    ['GET', '/a/example%2Fchild'],
  ])('includes %s %s', (method, pathname) => {
    expect(
      isViewerRateLimitedPath(
        new Request(`https://artifactshare.test${pathname}`, { method }),
      ),
    ).toBe(true)
  })

  test.each([
    ['POST', '/a/example'],
    ['GET', '/api/shareables/example'],
    ['GET', '/a/example/versions'],
    ['GET', '/a/example/%2Fversions'],
    ['GET', '/a/example/%ZZ'],
    ['GET', '/about'],
  ])('excludes %s %s', (method, pathname) => {
    expect(
      isViewerRateLimitedPath(
        new Request(`https://artifactshare.test${pathname}`, { method }),
      ),
    ).toBe(false)
  })
})

function request(method: string, clientIp: string | null): Request {
  return new Request('https://artifactshare.test/a/example~credential', {
    method,
    headers: clientIp ? { 'cf-connecting-ip': clientIp } : undefined,
  })
}

function denyLimiter(): ViewerRateLimiter {
  return { limit: vi.fn().mockResolvedValue({ success: false }) }
}
