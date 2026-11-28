import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'
import { useLatestRef } from '~/hooks/use-latest-ref'

export interface ViewerListRowView {
  userId: string
  name: string | null
  image: string | null
  lastViewedAt: string
  isSelf: boolean
  isExternal: boolean
}

export type ViewerListStatus = 'idle' | 'loading' | 'error' | 'loaded'

interface ViewerListFetchState {
  rows: ReadonlyArray<ViewerListRowView>
  totalViewers: number | null
  nextCursor: string | null
  status: ViewerListStatus
  loadingMore: boolean
}

const emptyViewerListRows: ReadonlyArray<ViewerListRowView> = []

function emptyViewerListState(): ViewerListFetchState {
  return {
    rows: emptyViewerListRows,
    totalViewers: null,
    nextCursor: null,
    status: 'idle',
    loadingMore: false,
  }
}

function parseViewerListRows(value: unknown): ViewerListRowView[] | null {
  if (!Array.isArray(value)) return null
  const rows: ViewerListRowView[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    if (
      typeof row.userId !== 'string' ||
      (row.name !== null && typeof row.name !== 'string') ||
      (row.image !== null && typeof row.image !== 'string') ||
      typeof row.lastViewedAt !== 'string' ||
      typeof row.isSelf !== 'boolean' ||
      typeof row.isExternal !== 'boolean'
    ) {
      return null
    }
    rows.push({
      userId: row.userId,
      name: (row.name as string | null) ?? null,
      image: (row.image as string | null) ?? null,
      lastViewedAt: row.lastViewedAt,
      isSelf: row.isSelf,
      isExternal: row.isExternal,
    })
  }
  return rows
}

export function useViewerList({
  artifactId,
  open,
}: {
  artifactId: string
  open: boolean
}) {
  const [state, setState] = useState<ViewerListFetchState>(emptyViewerListState)
  const seqRef = useRef(0)
  const generationRef = useRef(0)
  const openRef = useLatestRef(open)
  const artifactIdRef = useLatestRef(artifactId)
  const abortRef = useRef<AbortController | null>(null)
  const loadMoreInFlightRef = useRef(false)
  const nextCursorRef = useLatestRef(state.nextCursor)

  const [trackedArtifactId, setTrackedArtifactId] = useState(artifactId)
  if (trackedArtifactId !== artifactId) {
    setTrackedArtifactId(artifactId)
    setState(emptyViewerListState())
  }
  useLayoutEffect(() => {
    generationRef.current += 1
    seqRef.current += 1
    loadMoreInFlightRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
  }, [artifactId])

  const runFetch = useCallback(
    (mode: 'initial' | 'more') => {
      const requestArtifactId = artifactIdRef.current
      const generation = generationRef.current
      const cursor = mode === 'more' ? nextCursorRef.current : null
      const seq = seqRef.current + 1
      seqRef.current = seq
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      if (mode === 'more') loadMoreInFlightRef.current = true
      setState((current) =>
        mode === 'initial'
          ? { ...emptyViewerListState(), status: 'loading' }
          : { ...current, loadingMore: true },
      )
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      void fetchJsonWithViewerTimeout<{
        viewers?: unknown
        nextCursor?: unknown
        totalViewers?: unknown
      }>(
        `/api/shareables/${encodeURIComponent(requestArtifactId)}/viewers${query}`,
        {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        },
      )
        .catch((error: unknown) => {
          logViewerNetworkEvent({
            channel: 'fetch',
            purpose: 'viewer-list',
            state: 'failed',
            reason: viewerFetchFailureReason(error),
          })
          return null
        })
        .then((result) => {
          if (abortRef.current === controller) abortRef.current = null
          if (mode === 'more' && seq === seqRef.current) {
            loadMoreInFlightRef.current = false
          }
          if (seq !== seqRef.current) return
          if (generation !== generationRef.current) return
          if (artifactIdRef.current !== requestArtifactId) return
          if (!openRef.current) return
          const response = result?.response
          if (response && !response.ok) {
            logViewerNetworkEvent({
              channel: 'fetch',
              purpose: 'viewer-list',
              state: 'response-error',
              status: response.status,
              cfRay: cfRayFrom(response),
            })
          }
          const body = result?.body ?? null
          const rows = body ? parseViewerListRows(body.viewers) : null
          if (!response?.ok || !rows) {
            setState((current) =>
              mode === 'initial'
                ? { ...current, status: 'error' }
                : { ...current, loadingMore: false },
            )
            return
          }
          setState((current) => ({
            rows: mode === 'initial' ? rows : [...current.rows, ...rows],
            totalViewers:
              typeof body?.totalViewers === 'number'
                ? body.totalViewers
                : current.totalViewers,
            nextCursor:
              typeof body?.nextCursor === 'string' ? body.nextCursor : null,
            status: 'loaded',
            loadingMore: false,
          }))
        })
    },
    [artifactIdRef, nextCursorRef, openRef],
  )

  const openFetch = useCallback(() => {
    generationRef.current += 1
    loadMoreInFlightRef.current = false
    runFetch('initial')
  }, [runFetch])

  const loadMore = useCallback(() => {
    if (!openRef.current) return
    if (loadMoreInFlightRef.current) return
    if (!nextCursorRef.current) return
    runFetch('more')
  }, [nextCursorRef, openRef, runFetch])

  const retry = useCallback(() => {
    if (!openRef.current) return
    runFetch('initial')
  }, [openRef, runFetch])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    [],
  )

  return {
    rows: state.rows,
    totalViewers: state.totalViewers,
    nextCursor: state.nextCursor,
    status: state.status,
    loadingMore: state.loadingMore,
    openFetch,
    loadMore,
    retry,
  }
}
