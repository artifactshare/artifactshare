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

describe('comment operation diagnostics', () => {
  test('retains status 200 when required JSON is malformed', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(
        fetchJsonWithViewerTimeout(
          '/comments',
          {},
          {
            requireJson: true,
            commentDiagnostic: { operation: 'summary' },
          },
        ),
      ).rejects.toMatchObject({ name: 'ViewerFetchInvalidJsonError' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledTimes(2)
      expect(log.mock.calls.map(([, event]) => event)).toEqual([
        {
          channel: 'comment-sync',
          operation: 'summary',
          state: 'started',
          result: 'pending',
          elapsedMs: 0,
          fetchCount: 1,
          socketCount: 0,
        },
        {
          channel: 'comment-sync',
          operation: 'summary',
          state: 'completed',
          result: 'invalid-json',
          status: 200,
          elapsedMs: expect.any(Number),
          fetchCount: 0,
          socketCount: 0,
        },
      ])
    } finally {
      log.mockRestore()
    }
  })

  test.each([
    ['success', 200, { threads: [] }],
    ['http-error', 403, { error: 'must not be logged' }],
  ] as const)(
    'counts successful and failed attempts alike: %s',
    async (result, status, body) => {
      const log = vi.spyOn(console, 'info').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json(body, { status })),
      )
      try {
        await fetchJsonWithViewerTimeout(
          '/sensitive-url?token=private',
          {},
          { commentDiagnostic: { operation: 'selected' } },
        )
        expect(log).toHaveBeenCalledTimes(2)
        expect(log.mock.calls.map(([, event]) => event)).toEqual([
          {
            channel: 'comment-sync',
            operation: 'selected',
            state: 'started',
            result: 'pending',
            elapsedMs: 0,
            fetchCount: 1,
            socketCount: 0,
          },
          {
            channel: 'comment-sync',
            operation: 'selected',
            state: 'completed',
            result,
            status,
            elapsedMs: expect.any(Number),
            fetchCount: 0,
            socketCount: 0,
          },
        ])
        expect(JSON.stringify(log.mock.calls)).not.toMatch(
          /private|sensitive|must not be logged/,
        )
      } finally {
        log.mockRestore()
      }
    },
  )

  test('reports a sanitized network failure', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    let reject!: (error: Error) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, fail) => {
            reject = fail
          }),
      ),
    )
    const request = fetchJsonWithViewerTimeout(
      '/private-url',
      {},
      { commentDiagnostic: { operation: 'reply' } },
    )
    const rejected = expect(request).rejects.toThrow('raw error')
    try {
      reject(new Error('raw error containing token'))
      await rejected
      expect(log.mock.calls.at(-1)?.[1]).toEqual({
        channel: 'comment-sync',
        operation: 'reply',
        state: 'completed',
        result: 'network-error',
        elapsedMs: expect.any(Number),
        fetchCount: 0,
        socketCount: 0,
      })
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private-url|raw error|token/,
      )
    } finally {
      reject(new Error('cleanup'))
      await request.catch(() => {})
      log.mockRestore()
    }
  })

  test('an already cancelled read does not inflate fetch counts', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(
        fetchJsonWithViewerTimeout(
          '/unused',
          { signal: controller.signal },
          {
            commentDiagnostic: {
              operation: 'page',
            },
          },
        ),
      ).rejects.toSatisfy(isViewerFetchAbort)
      expect(fetch).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
