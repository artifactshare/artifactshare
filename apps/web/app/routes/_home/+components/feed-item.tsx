import { feedLocation } from './feed-location'
import { feedEventText } from './feed-event-text'
import { Link } from 'react-router'
import {
  IconEye,
  IconMessage,
  IconGitBranch,
  IconPlus,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { FeedEventRow } from '~/services/events.server'
import { formatRelative } from '~/lib/datetime'
import { useT } from '~/hooks/use-t'

const eventIcons: Partial<Record<FeedEventRow['type'], typeof IconEye>> = {
  artifact_viewed: IconEye,
  comment_posted: IconMessage,
  version_published: IconGitBranch,
}
const eventIconClasses: Partial<Record<FeedEventRow['type'], string>> = {
  artifact_viewed: 'bg-link-soft text-link',
  comment_posted: 'text-link',
  version_published: 'bg-warning-soft text-warning',
}

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
  const isAddDigest =
    row.type === 'artifact_created' && (row.addCount ?? 0) >= 2
  const isDigest = typeof row.viewedFileCount === 'number'
  const text = feedEventText(row, t)
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
  const location = feedLocation(row, showLocation, t)
  const Icon = eventIcons[row.type] ?? IconPlus
  const iconClass =
    eventIconClasses[row.type] ?? 'bg-muted text-muted-foreground'
  return (
    <li className="border-divider flex gap-3 border-b px-1 py-3 text-sm">
      <span
        aria-hidden="true"
        className={`flex size-6 shrink-0 items-center justify-center rounded ${iconClass}`}
      >
        <Icon size={16} />
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
