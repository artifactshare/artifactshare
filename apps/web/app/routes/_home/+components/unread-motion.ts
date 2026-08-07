import type { TKey } from '~/i18n/messages'
import type { FileRowData } from './file-data'

type Vars = Record<string, string | number>

export function fileHasUnread(
  data: Pick<FileRowData, 'unreadVersionCount' | 'unreadCommentCount'>,
): boolean {
  return (
    (data.unreadVersionCount ?? 0) > 0 || (data.unreadCommentCount ?? 0) > 0
  )
}

export function unreadNewCommentLabel(
  count: number,
  t: (key: TKey, vars?: Vars) => string,
  tPlural: (stem: string, n: number, vars?: Vars) => string,
): string | null {
  if (count <= 0) return null
  if (count >= 100) return t('row.newCommentsOther', { count: '99+' })
  return tPlural('row.newComments', count, { count: String(count) })
}
