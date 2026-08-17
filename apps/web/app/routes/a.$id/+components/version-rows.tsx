import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { formatBytes } from '~/lib/format'
import { cn } from '~/lib/utils'
import { Link } from 'react-router'
import type { VersionRow } from './version-history-types'

export function VersionRows({
  versions,
  locale,
  t,
  density = 'panel',
  artifactId,
  displayedVersionId,
  onVersionSelect,
}: {
  versions: ReadonlyArray<VersionRow>
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
  density?: 'panel' | 'popover'
  artifactId?: string
  displayedVersionId?: string | null
  onVersionSelect?: () => void
}) {
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground m-0 text-xs">{t('history.empty')}</p>
    )
  }

  return (
    <ul
      className={cn(
        'm-0 flex list-none flex-col p-0',
        density === 'popover' ? 'gap-1' : 'gap-1.5',
      )}
    >
      {versions.map((version) => (
        <li
          className={cn(
            'flex flex-col gap-0.5 rounded-[var(--r-md)] border',
            density === 'popover'
              ? 'py-version-row-pad-block border-divider px-2'
              : 'border-border px-2.5 py-2',
          )}
          key={version.id}
        >
          {artifactId ? (
            <Link
              to={
                version.isCurrent
                  ? `/a/${encodeURIComponent(artifactId)}`
                  : `/a/${encodeURIComponent(artifactId)}?version=${encodeURIComponent(version.id)}`
              }
              aria-current={
                displayedVersionId === version.id ||
                (!displayedVersionId && version.isCurrent)
                  ? 'page'
                  : undefined
              }
              className="text-foreground hover:bg-accent -m-1 flex rounded-[var(--r-sm)] p-1 no-underline"
              onClick={(event) => {
                if (
                  displayedVersionId === version.id ||
                  (!displayedVersionId && version.isCurrent)
                ) {
                  event.preventDefault()
                  return
                }
                onVersionSelect?.()
              }}
            >
              <VersionRowContent version={version} locale={locale} t={t} />
            </Link>
          ) : (
            <VersionRowContent version={version} locale={locale} t={t} />
          )}
        </li>
      ))}
    </ul>
  )
}

function VersionRowContent({
  version,
  locale,
  t,
}: {
  version: VersionRow
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center gap-1.5 text-sm">
        <strong>v{version.ordinal}</strong>
        {version.isCurrent ? (
          <span className="bg-link-soft text-link rounded-full px-1.5 py-px text-xs">
            {t('history.current')}
          </span>
        ) : null}
      </div>
      <div className="text-muted-foreground flex gap-1.5 text-xs">
        {version.createdByLabel ? (
          <>
            <span>{version.createdByLabel}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span>{formatRelative(version.createdAt, locale)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatBytes(version.sizeBytes)}</span>
      </div>
    </div>
  )
}
