import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import type { FileRowData } from '../+components/file-data'

export interface FileLabels {
  owner: string
  commentsShort: string
  views: string
  activity: string
  visibility: string
  /** null when modifiedTime is unset — callers choose their own placeholder. */
  modified: string | null
}

export function useFileLabels(data: FileRowData): FileLabels {
  const { t, tPlural, locale } = useT()
  return {
    owner: data.ownerName ?? data.ownerEmail ?? '—',
    commentsShort: tPlural('table.commentCount', data.commentCount),
    views: tPlural('card.viewCount', data.viewCount),
    activity: `${data.viewCount} · ${data.commentCount}`,
    visibility: t(shortVisibilityLabelKey(data.visibility)),
    modified: data.modifiedTime
      ? formatRelative(data.modifiedTime, locale)
      : null,
  }
}
