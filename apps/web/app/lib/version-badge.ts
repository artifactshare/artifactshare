import type { FileRowData } from '~/routes/_home/+components/file-data'

const VERSION_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 「vN に更新」は人による最新公開版が v2 以上、かつ発行から 7 日以内。
// Undefined preserves older synthetic rows; null explicitly means no eligible version.
export function versionBadgeLabel(
  file: FileRowData,
  now: string,
  label: (version: number) => string,
): string | null {
  const number =
    file.badgeVersionNumber === undefined
      ? file.versionCount
      : file.badgeVersionNumber
  if ((number ?? 0) < 2 || !file.latestPublishedAt) return null
  const age = Date.parse(now) - Date.parse(file.latestPublishedAt)
  if (Number.isNaN(age) || age > VERSION_BADGE_WINDOW_MS) return null
  return label(number ?? 0)
}
