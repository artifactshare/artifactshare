import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  fetchJsonWithViewerTimeout,
  isViewerFetchAbort,
  isViewerFetchTimeout,
  VIEWER_FETCH_TIMEOUT_MS,
} from './viewer-network'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchJsonWithViewerTimeout', () => {
  test('rejects with a viewer timeout when fetch does not finish', async () => {
    vi.useFakeTimers()
    stubAbortableFetch()

    const request = expect(
      fetchJsonWithViewerTimeout('/slow'),
    ).rejects.toSatisfy(isViewerFetchTimeout)

    await vi.advanceTimersByTimeAsync(VIEWER_FETCH_TIMEOUT_MS)

    await request
  })

  test('rejects with a viewer abort when the caller signal aborts first', async () => {
    vi.useFakeTimers()
    stubAbortableFetch()
    const controller = new AbortController()

    const request = fetchJsonWithViewerTimeout('/aborted', {
      signal: controller.signal,
    })
    controller.abort()

    await expect(request).rejects.toSatisfy(isViewerFetchAbort)
  })

  test('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('Aborted', 'AbortError'))
                })
              },
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
      ),
    )

    const request = expect(
      fetchJsonWithViewerTimeout('/headers-only'),
    ).rejects.toSatisfy(isViewerFetchTimeout)

    await vi.advanceTimersByTimeAsync(VIEWER_FETCH_TIMEOUT_MS)

    await request
  })

  test.each([
    ['rate-limited', 429],
    ['thread-capacity', 409],
    ['version_conflict', 409],
  ])(
    'reads the actual %s error envelope when opted in',
    async (code, status) => {
      const error = { code, details: { retry_after_seconds: 12 } }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            { error },
            { status: Number(status), headers: { 'Retry-After': '12' } },
          ),
        ),
      )
      const result = await fetchJsonWithViewerTimeout(
        '/comments',
        {},
        {
          requireJson: true,
          parseErrorJson: true,
        },
      )
      expect(result.body).toEqual({ error })
      expect(result.response.status).toBe(status)
      expect(result.response.headers.get('Retry-After')).toBe('12')
      expect((await fetchJsonWithViewerTimeout('/comments')).body).toBeNull()
    },
  )

  test.each([401, 403, 409, 429])(
    'retains status %s for non-JSON error pages',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>Error</html>', { status })),
      )
      const result = await fetchJsonWithViewerTimeout(
        '/comments',
        {},
        {
          requireJson: true,
          parseErrorJson: true,
        },
      )
      expect(result.response.status).toBe(status)
      expect(result.body).toBeNull()
    },
  )

  test.each(['timeout', 'abort'])(
    'retains %s coverage during an error body read',
    async (reason) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (_input, init: RequestInit) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  init.signal?.addEventListener('abort', () =>
                    controller.error(new DOMException('Aborted', 'AbortError')),
                  )
                },
              }),
              { status: 429 },
            ),
        ),
      )
      const request = expect(
        fetchJsonWithViewerTimeout(
          '/comments',
          { signal: caller.signal },
          {
            parseErrorJson: true,
          },
        ),
      ).rejects.toSatisfy(
        reason === 'timeout' ? isViewerFetchTimeout : isViewerFetchAbort,
      )
      await Promise.resolve()
      if (reason === 'timeout')
        await vi.advanceTimersByTimeAsync(VIEWER_FETCH_TIMEOUT_MS)
      else caller.abort()
      await request
    },
  )

  test('rejects invalid JSON when the body is required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not json'))),
    )

    await expect(
      fetchJsonWithViewerTimeout('/invalid-json', {}, { requireJson: true }),
    ).rejects.toMatchObject({ name: 'ViewerFetchInvalidJsonError' })
  })
})

function stubAbortableFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    ),
  )
}
