import { describe, expect, test } from 'vitest'
import { linkPublishRateLimitedResponse } from './api-errors'

describe('link publish rate limit response', () => {
  test('is a 429 with Retry-After and the details the dialog reads', async () => {
    const response = linkPublishRateLimitedResponse({
      limit: 20,
      retryAfterSeconds: 7201,
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('7201')
    expect(await response.json()).toEqual({
      error: {
        code: 'link-publish-rate-limited',
        message: expect.stringContaining('retry in 3 hours'),
        details: { limit: 20, retryAfterSeconds: 7201 },
      },
    })
  })
})
