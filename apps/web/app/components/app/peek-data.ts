import { useCallback, useState } from 'react'

export type ShareableData = {
  id: string
  title: string
  description: string | null
  ownerName: string
  ownerId: string
  ownerImage: string | null
  viewCount: number
  commentCount: number
  createdAt: string
  publishedAt: string | null
  versionCount: number
  containerName: string | null
  containerKind: string | null
  excerpt: string | null
}
export type ProjectData = {
  id: string
  name: string
  description: string | null
  fileCount: number
  participantCount: number
  updatedAt: string
  recentFiles: { id: string; title: string; kind: string }[]
}

const cache = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()
let cachePath = ''

// ページ遷移 (pathname 変化) でキャッシュを捨てる。404 / 失敗は null を負キャッシュ
// して同一ページ内の再 hover で再試行しない。
export function loadPeek(
  kind: 'shareable' | 'project',
  id: string,
  pathname: string,
): Promise<unknown> {
  if (cachePath && cachePath !== pathname) {
    cache.clear()
    pending.clear()
  }
  cachePath = pathname
  const key = `${kind}:${id}`
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const request = fetch(`/api/peek/${kind}/${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((value) => {
      cache.set(key, value)
      pending.delete(key)
      return value
    })
  pending.set(key, request)
  return request
}

export function usePeekData<T extends ShareableData | ProjectData>(
  kind: 'shareable' | 'project',
  id: string,
  pathname: string,
) {
  const [data, setData] = useState<T | null | undefined>(undefined)
  const load = useCallback(() => {
    void loadPeek(kind, id, pathname).then((value) =>
      setData(value as T | null),
    )
  }, [kind, id, pathname])
  return { data, load }
}
