import { Link } from 'react-router'
import {
  IconEye,
  IconMessage,
  IconGitBranch,
  IconPlus,
  IconHome,
  IconStack2 as Layers,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { FeedEventRow } from '~/services/events.server'
import { formatRelative } from '~/lib/datetime'
import { useT } from '~/hooks/use-t'

// 翻訳済み文字列の placeholder 位置へリンク要素を差し込む ({title} / {project})
function inline(value: string, name: string, child: ReactNode) {
  const parts = value.split(`{${name}}`)
  return parts.length === 2 ? (
    <>
      {parts[0]}
      {child}
      {parts[1]}
    </>
  ) : (
    value
  )
}

export function FeedItem({
  row,
  compact = false,
  showLocation = false,
}: {
  row: FeedEventRow
  compact?: boolean
  showLocation?: boolean
}) {
  const { locale, t } = useT()
  const actor = row.actorName ?? t('home.unknownActor')
  const isAddDigest =
    row.type === 'artifact_created' && (row.addCount ?? 0) >= 2
  const isDigest = typeof row.viewedFileCount === 'number'
  const vars = { actor, title: '{title}' }
  const text = isAddDigest
    ? t('home.actorAddedToProjectCount', {
        actor,
        project: '{project}',
        count: String(row.addCount),
      })
    : row.type === 'artifact_created'
      ? t('home.actorAddedInline', vars)
      : row.type === 'artifact_viewed'
        ? isDigest
          ? (row.viewUniqueCount
              ? t(
                  row.viewUniqueCount === 1
                    ? 'home.viewDigest_one'
                    : 'home.viewDigest_other',
                  {
                    files: String(row.viewedFileCount),
                    count: String(row.viewUniqueCount),
                  },
                )
              : t(
                  row.anonymousViewCount === 1
                    ? 'home.viewDigestAnonymous_one'
                    : 'home.viewDigestAnonymous_other',
                  {
                    files: String(row.viewedFileCount),
                    count: String(row.anonymousViewCount ?? 0),
                  },
                )) +
            (row.viewUniqueCount && row.anonymousViewCount
              ? ` · ${t(row.anonymousViewCount === 1 ? 'home.anonymousViewsSuffix_one' : 'home.anonymousViewsSuffix_other', { count: String(row.anonymousViewCount) })}`
              : '')
          : (row.viewUniqueCount
              ? t(
                  row.viewUniqueCount === 1
                    ? 'home.viewedByInline_one'
                    : 'home.viewedByInline_other',
                  { ...vars, count: String(row.viewUniqueCount) },
                )
              : t(
                  row.anonymousViewCount === 1
                    ? 'home.anonymousViewsInline_one'
                    : 'home.anonymousViewsInline_other',
                  { ...vars, count: String(row.anonymousViewCount ?? 0) },
                )) +
            (row.viewUniqueCount && row.anonymousViewCount
              ? ` · ${t(row.anonymousViewCount === 1 ? 'home.anonymousViewsSuffix_one' : 'home.anonymousViewsSuffix_other', { count: String(row.anonymousViewCount) })}`
              : '')
        : row.type === 'comment_posted'
          ? t(
              row.commentCount !== null
                ? 'home.actorCommentedCountInline'
                : 'home.actorCommentedInline',
              row.commentCount !== null
                ? { ...vars, count: String(row.commentCount) }
                : vars,
            )
          : row.type === 'version_published'
            ? row.versionStart !== null && row.versionEnd !== null
              ? t(
                  row.versionAuthorCount === 1
                    ? 'home.actorPublishedRangeInline'
                    : 'home.publishedRangeInline',
                  row.versionAuthorCount === 1
                    ? {
                        ...vars,
                        start: String(row.versionStart),
                        end: String(row.versionEnd),
                      }
                    : {
                        title: '{title}',
                        start: String(row.versionStart),
                        end: String(row.versionEnd),
                      },
                )
              : t('home.actorPublishedInline', {
                  ...vars,
                  version: String(row.versionNumber ?? 1),
                })
            : t('home.actorAddedInline', vars)
  const artifactLink = (
    <Link
      className="text-foreground font-medium hover:underline"
      to={`/a/${row.shareableId}`}
    >
      {row.shareableTitle}
    </Link>
  )
  const renderedText = isAddDigest
    ? inline(
        text,
        'project',
        <Link
          className="text-foreground font-medium hover:underline"
          to={`/projects/${row.containerId}/files`}
        >
          {row.containerName}
        </Link>,
      )
    : !isDigest && row.type !== 'comment_posted'
      ? inline(text, 'title', artifactLink)
      : row.type === 'comment_posted'
        ? inline(text, 'title', artifactLink)
        : text
  // 場所は単一対象の行だけ。閲覧ダイジェスト (複数ファイル束ね) と追加束ね
  // (本文のプロジェクト名が場所) には出さない
  const location =
    showLocation &&
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
  const iconClass =
    row.type === 'artifact_viewed'
      ? 'bg-link-soft text-link'
      : row.type === 'comment_posted'
        ? 'text-link'
        : row.type === 'version_published'
          ? 'bg-warning-soft text-warning'
          : 'bg-muted text-muted-foreground'
  return (
    <li className="border-divider flex gap-3 border-b px-1 py-3 text-sm">
      <span
        aria-hidden="true"
        className={`flex size-6 shrink-0 items-center justify-center rounded ${iconClass}`}
      >
        {row.type === 'artifact_viewed' ? (
          <IconEye size={16} />
        ) : row.type === 'comment_posted' ? (
          <IconMessage size={16} />
        ) : row.type === 'version_published' ? (
          <IconGitBranch size={16} />
        ) : (
          <IconPlus size={16} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="wrap-anywhere">{renderedText}</div>
        {isDigest ? (
          <div className="text-muted-foreground max-stack:line-clamp-2 wrap-anywhere">
            {t('home.viewDigestTop')}{' '}
            {row.viewTopItems?.map((item, index) => (
              <span key={item.shareableId}>
                {index > 0 ? t('home.listSeparator') : null}
                <Link
                  className="text-foreground font-medium hover:underline"
                  to={`/a/${item.shareableId}`}
                >
                  {item.title}
                </Link>
                <span className="text-muted-foreground"> ({item.count})</span>
              </span>
            ))}
          </div>
        ) : null}
        {row.commentBody && !compact ? (
          <p className="text-muted-foreground line-clamp-2">
            {row.commentBody}
          </p>
        ) : null}
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <time dateTime={row.createdAt}>
            {formatRelative(row.createdAt, locale)}
          </time>
          {location ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1">{location}</span>
            </>
          ) : null}
        </div>
      </div>
    </li>
  )
}
