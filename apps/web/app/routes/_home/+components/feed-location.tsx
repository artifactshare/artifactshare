import { IconHome, IconStack2 as Layers } from '@tabler/icons-react'
import type { FeedEventRow } from '~/services/events.server'
import type { Translator } from '~/lib/i18n'

export function feedLocation(
  row: FeedEventRow,
  showLocation: boolean,
  t: Translator['t'],
) {
  const isDigest = typeof row.viewedFileCount === 'number'
  const isAddDigest =
    row.type === 'artifact_created' && (row.addCount ?? 0) >= 2
  // 場所は単一対象の行だけ。閲覧ダイジェスト (複数ファイル束ね) と追加束ね
  // (本文のプロジェクト名が場所) には出さない
  return showLocation &&
    !isDigest &&
    !isAddDigest &&
    (row.isViewerInbox ||
      (row.containerKind === 'project' && row.containerName)) ? (
    row.isViewerInbox ? (
      <>
        <IconHome size={13} aria-hidden="true" /> {t('tb.home')}
      </>
    ) : (
      <>
        <Layers size={13} aria-hidden="true" /> {row.containerName}
      </>
    )
  ) : null
}
