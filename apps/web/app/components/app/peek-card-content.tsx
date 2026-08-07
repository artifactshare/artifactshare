import { IconHome, IconStack2 } from '@tabler/icons-react'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { formatRelative } from '~/lib/datetime'
import { useT } from '~/hooks/use-t'
import type { ProjectData, ShareableData } from './peek-data'

export function ShareableContent({ data }: { data: ShareableData }) {
  const { t, locale } = useT()
  return (
    <div
      data-peek-section="shareable"
      className="flex h-full min-w-0 flex-col gap-2"
    >
      <p
        data-peek-part="title"
        className="shrink-0 truncate text-sm font-semibold"
      >
        {data.title}
      </p>
      <p
        data-peek-part="body"
        className="text-muted-foreground line-clamp-2 min-h-0 flex-1 overflow-hidden text-sm"
      >
        {data.excerpt || t('peek.noExcerpt')}
      </p>
      <div
        data-peek-part="meta"
        className="text-muted-foreground flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap"
      >
        <AuthorAvatar
          id={data.ownerId}
          image={data.ownerImage}
          initial={data.ownerName?.[0] ?? '?'}
          size="xs"
        />
        <span className="min-w-0 truncate">{data.ownerName}</span>
        {data.versionCount > 0 ? (
          <span className="shrink-0">· v{data.versionCount}</span>
        ) : null}
        <span className="shrink-0">
          · {formatRelative(data.publishedAt ?? data.createdAt, locale)}
        </span>
        {data.containerKind === 'project' ? (
          <span data-peek-location="project" className="min-w-0 truncate">
            <IconStack2 size={13} className="inline" /> {data.containerName}
          </span>
        ) : data.containerKind === 'inbox' ? (
          <span data-peek-location="inbox" className="shrink-0">
            <IconHome size={13} className="inline" /> {t('tb.home')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function ProjectContent({ data }: { data: ProjectData }) {
  const { t, tPlural, locale } = useT()
  return (
    <div
      data-peek-section="project"
      className="flex h-full min-w-0 flex-col gap-2"
    >
      <p
        data-peek-part="title"
        className="shrink-0 truncate text-sm font-semibold"
      >
        {data.name}
      </p>
      <div
        data-peek-part="recent-files"
        className="max-h-14 min-h-0 space-y-1 overflow-hidden"
      >
        {data.recentFiles.length ? (
          data.recentFiles.map((f) => (
            <div key={f.id} className="flex items-center gap-1 text-sm">
              <FileTypeIcon renderType={f.kind as never} size="sm" />{' '}
              <span className="truncate">{f.title}</span>
            </div>
          ))
        ) : (
          <div className="text-muted-foreground text-sm">
            {t('peek.noFiles')}
          </div>
        )}
      </div>
      <p
        data-peek-part="description"
        className="text-muted-foreground line-clamp-2 min-h-0 flex-1 overflow-hidden text-sm"
      >
        {data.description || t('peek.noDescription')}
      </p>
      <div
        data-peek-part="counts"
        className="text-muted-foreground shrink-0 truncate text-xs"
      >
        {tPlural('tb.fileCount', data.fileCount)} ·{' '}
        {t('peek.participants', { count: data.participantCount })} ·{' '}
        {formatRelative(data.updatedAt, locale)}
      </div>
    </div>
  )
}
