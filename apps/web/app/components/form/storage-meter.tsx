import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
export function StorageMeter({
  usedBytes,
  quotaBytes,
  warnNearLimit = true,
}: {
  usedBytes: number
  warnNearLimit?: boolean
  quotaBytes: number
}) {
  const { t } = useT()
  const percent =
    Number.isFinite(usedBytes) && Number.isFinite(quotaBytes) && quotaBytes > 0
      ? Math.max(0, (usedBytes / quotaBytes) * 100)
      : null
  const fill = percent === null ? 0 : Math.min(percent, 100)
  const label =
    percent === null ? t('storage.unavailable') : `${Math.round(percent)}%`
  return (
    <div className="mt-3 flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={t('team.usage.storageUsed')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : fill}
        aria-valuetext={label}
        className="bg-muted h-1.5 overflow-hidden rounded-full"
      >
        <div
          data-slot="progress-indicator"
          className={cn(
            'h-full',
            warnNearLimit && percent !== null && percent >= 90
              ? 'bg-warning'
              : 'bg-link',
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  )
}
