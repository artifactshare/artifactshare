import { Progress } from '~/components/ui/progress'

export function StorageMeter({
  usedBytes,
  quotaBytes,
}: {
  usedBytes: number
  quotaBytes: number
}) {
  const percent =
    quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  return (
    <Progress
      value={percent}
      aria-hidden="true"
      className="bg-muted [&_[data-slot=progress-indicator]]:bg-link mt-[var(--spacing-3)] h-1.5 overflow-hidden rounded-[var(--r-full)]"
    />
  )
}
