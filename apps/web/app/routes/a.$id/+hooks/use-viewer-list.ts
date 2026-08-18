import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'

export interface ViewerListRowView {
  userId: string
  name: string | null
  image: string | null
  lastViewedAt: string
  isSelf: boolean
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
      typeof row.isSelf !== 'boolean'
    ) {
      return null
    }
    rows.push({
      userId: row.userId,
      name: (row.name as string | null) ?? null,
      image: (row.image as string | null) ?? null,
      lastViewedAt: row.lastViewedAt,
      isSelf: row.isSelf,
    })
  }
  return rows
}

// 閲覧者一覧の取得状態。開くたびに取得 (クライアントキャッシュなし)。
// 順序の正は request sequence (最後に開始した操作の応答のみ適用) で、
// AbortController は帯域の最適化。stale 応答 (artifact 切替・クローズ後) は
// artifactId + open generation 照合で破棄する。
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
  const openRef = useRef(open)
  openRef.current = open
  const artifactIdRef = useRef(artifactId)
  artifactIdRef.current = artifactId
  const abortRef = useRef<AbortController | null>(null)
  const loadMoreInFlightRef = useRef(false)
  const nextCursorRef = useRef<string | null>(null)
  nextCursorRef.current = state.nextCursor

  // artifact 切替はコメント reducer と同じ render-phase 比較で検知し、取得済み
  // リストを破棄する (stale 応答は generation/seq 照合でも二重に弾かれる)。
  const [trackedArtifactId, setTrackedArtifactId] = useState(artifactId)
  if (trackedArtifactId !== artifactId) {
    setTrackedArtifactId(artifactId)
    generationRef.current += 1
    seqRef.current += 1
    loadMoreInFlightRef.current = false
    setState(emptyViewerListState())
  }

  const runFetch = useCallback((mode: 'initial' | 'more') => {
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
        // Only the last-started operation's response applies; stale responses
        // (artifact switched, panel closed/reopened) are discarded.
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
              : // 「さらに表示」失敗はボタンを再クリック可能なまま維持する。
                { ...current, loadingMore: false },
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
  }, [])

  // パネルを開くイベントで呼ぶ。開くたびに取得し (前回リストは即破棄)、
  // open generation を進めて閉→開をまたぐ stale 応答を無効化する。
  const openFetch = useCallback(() => {
    generationRef.current += 1
    loadMoreInFlightRef.current = false
    runFetch('initial')
  }, [runFetch])

  const loadMore = useCallback(() => {
    if (!openRef.current) return
    // 二重クリックは非重複 (最初の要求のみ)。再試行の連打は seq で最後の
    // 操作のみ反映される。
    if (loadMoreInFlightRef.current) return
    if (!nextCursorRef.current) return
    runFetch('more')
  }, [runFetch])

  const retry = useCallback(() => {
    if (!openRef.current) return
    runFetch('initial')
  }, [runFetch])

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
