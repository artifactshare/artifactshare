import { useT } from '~/hooks/use-t'

const badgeClassName =
  'bg-link-soft text-link shrink-0 rounded-full px-2 py-0.5 text-xs font-medium'

export function ProjectNewBadge({ count }: { count: number }) {
  const { t } = useT()
  if (count <= 0) return null

  return (
    <span className={badgeClassName}>
      {t('project.newBadge', {
        count: count > 99 ? '99+' : String(count),
      })}
    </span>
  )
}
