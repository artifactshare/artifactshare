import type { FileRowData } from '~/routes/_home/+components/file-data'

const VERSION_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 「vN に更新」は事実ベース: 版数 2 以上かつ最新 published 版の発行が 7 日以内。
export function versionBadgeLabel(
  file: FileRowData,
  now: string,
  label: (version: number) => string,
): string | null {
  if ((file.versionCount ?? 0) < 2 || !file.latestPublishedAt) return null
  const age = Date.parse(now) - Date.parse(file.latestPublishedAt)
  if (Number.isNaN(age) || age > VERSION_BADGE_WINDOW_MS) return null
  return label(file.versionCount ?? 0)
}
