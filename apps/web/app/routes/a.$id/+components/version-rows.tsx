import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { formatBytes } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { VersionRow } from './version-history-types'

export function VersionRows({
  versions,
  locale,
  t,
  density = 'panel',
}: {
  versions: ReadonlyArray<VersionRow>
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
  density?: 'panel' | 'popover'
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
      {versions.map((version) => {
        const destination = version.isCurrent
          ? '?'
          : `?version=${encodeURIComponent(version.id)}`
        return (
          <li
            className={cn(
              'flex flex-col gap-0.5 rounded-[var(--r-md)] border',
              density === 'popover'
                ? 'py-version-row-pad-block border-divider px-2'
                : 'border-border px-2.5 py-2',
              version.isDisplayed && 'border-link bg-link-soft',
            )}
            key={version.id}
          >
            <a
              href={destination}
              className="text-foreground -m-1 flex flex-col gap-0.5 rounded-[var(--r-sm)] p-1 no-underline"
              aria-current={version.isDisplayed ? 'page' : undefined}
            >
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
            </a>
          </li>
        )
      })}
    </ul>
  )
}
