// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewerList } from './viewer-shell'

type HookResult = ReturnType<typeof useViewerList>

interface Deferred {
  url: string
  init: RequestInit | undefined
  resolve: (body: unknown, status?: number) => void
  reject: (error?: unknown) => void
}

describe('useViewerList', () => {
  let root: Root
  let container: HTMLDivElement
  let latest: HookResult
  let pending: Deferred[]

  // ViewerShell と同じ配線: open はパネル開閉状態、開くイベントで openFetch()。
  function Harness({
    artifactId,
    open,
  }: {
    artifactId: string
    open: boolean
  }) {
    latest = useViewerList({ artifactId, open })
    return null
  }

  function openPanel(artifactId: string) {
    return React.act(async () => {
      latest.openFetch()
      root.render(<Harness artifactId={artifactId} open={true} />)
    })
  }

  beforeEach(() => {
    pending = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          pending.push({
            url: String(input),
            init,
            resolve: (body, status = 200) =>
              resolve(
                new Response(JSON.stringify(body), {
                  status,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            reject: (error) => reject(error ?? new TypeError('network down')),
          })
        })
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.unstubAllGlobals()
  })

  function render(artifactId: string, open: boolean) {
    return React.act(async () => {
      root.render(<Harness artifactId={artifactId} open={open} />)
    })
  }

  function viewersBody(
    ids: string[],
    { nextCursor = null as string | null, totalViewers = ids.length } = {},
  ) {
    return {
      viewers: ids.map((id) => ({
        userId: id,
        name: `User ${id}`,
        image: null,
        lastViewedAt: '2024-01-01T09:00:00Z',
        isSelf: false,
        isExternal: false,
      })),
      nextCursor,
      totalViewers,
    }
  }

  it('fetches with no-store on open and loads rows', async () => {
    await render('a1', false)
    expect(pending).toHaveLength(0)
    await openPanel('a1')
    expect(latest.status).toBe('loading')
    expect(pending).toHaveLength(1)
    expect(pending[0].url).toBe('/api/shareables/a1/viewers')
    expect(pending[0].init?.cache).toBe('no-store')
    await React.act(async () => {
      pending[0].resolve(viewersBody(['v1', 'v2'], { totalViewers: 2 }))
    })
    expect(latest.status).toBe('loaded')
    expect(latest.rows.map((row) => row.userId)).toEqual(['v1', 'v2'])
    expect(latest.totalViewers).toBe(2)
  })

  it('refetches on every open and resets the previous list', async () => {
    await render('a1', false)
    await openPanel('a1')
    await React.act(async () => {
      pending[0].resolve(viewersBody(['v1']))
    })
    expect(latest.rows).toHaveLength(1)
    await render('a1', false)
    await openPanel('a1')
    // Reopening resets to a fresh loading state and issues a new request.
    expect(latest.status).toBe('loading')
    expect(latest.rows).toHaveLength(0)
    expect(pending).toHaveLength(2)
  })

  it('applies only the last-started retry in a retry storm', async () => {
    await render('a1', false)
    await openPanel('a1')
    await React.act(async () => {
      pending[0].reject()
    })
    expect(latest.status).toBe('error')
    await React.act(async () => {
      latest.retry()
    })
    await React.act(async () => {
      latest.retry()
    })
    expect(pending).toHaveLength(3)
    // The last retry resolves first and wins.
    await React.act(async () => {
      pending[2].resolve(viewersBody(['winner']))
    })
    expect(latest.rows.map((row) => row.userId)).toEqual(['winner'])
    // The earlier retry resolving later is discarded (it was also aborted).
    await React.act(async () => {
      pending[1].resolve(viewersBody(['stale']))
    })
    expect(latest.rows.map((row) => row.userId)).toEqual(['winner'])
  })

  it('does not double-append when load more is double-clicked', async () => {
    await render('a1', false)
    await openPanel('a1')
    await React.act(async () => {
      pending[0].resolve(viewersBody(['v1'], { nextCursor: 'c1' }))
    })
    await React.act(async () => {
      latest.loadMore()
      latest.loadMore()
    })
    // The second synchronous click is ignored while the first is in flight.
    expect(pending).toHaveLength(2)
    await React.act(async () => {
      pending[1].resolve(viewersBody(['v2']))
    })
    expect(latest.rows.map((row) => row.userId)).toEqual(['v1', 'v2'])
  })

  it('keeps load-more retryable after a failure', async () => {
    await render('a1', false)
    await openPanel('a1')
    await React.act(async () => {
      pending[0].resolve(viewersBody(['v1'], { nextCursor: 'c1' }))
    })
    await React.act(async () => {
      latest.loadMore()
    })
    await React.act(async () => {
      pending[1].reject()
    })
    expect(latest.status).toBe('loaded')
    expect(latest.loadingMore).toBe(false)
    expect(latest.nextCursor).toBe('c1')
    await React.act(async () => {
      latest.loadMore()
    })
    expect(pending).toHaveLength(3)
    await React.act(async () => {
      pending[2].resolve(viewersBody(['v2']))
    })
    expect(latest.rows.map((row) => row.userId)).toEqual(['v1', 'v2'])
  })

  it('discards a stale response after the artifact switches', async () => {
    await render('a1', false)
    await openPanel('a1')
    expect(pending).toHaveLength(1)
    // The shell reducer closes the panel on artifact change; the fetched
    // list must be discarded even if the old response arrives afterwards.
    await render('a2', false)
    await React.act(async () => {
      pending[0].resolve(viewersBody(['old-artifact']))
    })
    expect(latest.rows).toHaveLength(0)
    expect(latest.status).toBe('idle')
  })

  it('discards a response that arrives after close', async () => {
    await render('a1', false)
    await openPanel('a1')
    await render('a1', false)
    await React.act(async () => {
      pending[0].resolve(viewersBody(['late']))
    })
    expect(latest.rows).toHaveLength(0)
    expect(latest.status).not.toBe('loaded')
  })
})
