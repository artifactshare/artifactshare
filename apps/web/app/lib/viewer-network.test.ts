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
