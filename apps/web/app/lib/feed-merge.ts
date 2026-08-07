// フィード行のクライアント併合キー。閲覧集約はページをまたぐと別の生イベント
// id で再出現するため、id でなくサーバと同じローカル日キーで重複排除する。
// 数値はサーバがキー全体の完全値を返すので、先勝ちで足し合わせない (events.md)。
type MergeableFeedRow = {
  id: string
  type: string
  shareableId: string
  createdAt: string
  dayKey: string
  viewedFileCount?: number | null
  addCount?: number | null
  containerId?: string | null
  actorId?: string | null
}

function feedRowKey(row: MergeableFeedRow): string {
  if (
    row.addCount !== null &&
    row.addCount !== undefined &&
    row.containerId &&
    row.actorId
  )
    return `add:${row.actorId}:${row.containerId}:${row.dayKey}`
  if (
    row.type === 'artifact_viewed' &&
    row.viewedFileCount !== null &&
    row.viewedFileCount !== undefined
  )
    return `viewday:${row.dayKey}`
  return row.type === 'artifact_viewed'
    ? `view:${row.shareableId}:${row.dayKey}`
    : row.type === 'version_published' &&
        'versionStart' in row &&
        row.versionStart !== null
      ? `version:${row.shareableId}:${row.dayKey}`
      : row.type === 'comment_posted' &&
          'commentCount' in row &&
          row.commentCount !== null &&
          'actorId' in row &&
          row.actorId !== null
        ? `comment:${row.actorId}:${row.shareableId}:${row.dayKey}`
        : `id:${row.id}`
}

export function mergeFeedRows<T extends MergeableFeedRow>(pages: T[][]): T[] {
  const merged = new Map<string, T>()
  for (const page of pages)
    for (const row of page) {
      const key = feedRowKey(row)
      if (!merged.has(key)) merged.set(key, row)
    }
  return [...merged.values()]
}
