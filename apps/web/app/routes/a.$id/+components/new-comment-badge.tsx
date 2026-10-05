import { useT } from '~/hooks/use-t'

export function NewCommentBadge() {
  const { t } = useT()
  return (
    <span className="text-link bg-accent px-comment-badge-inline shrink-0 rounded-[var(--r-sm)] py-px text-xs font-semibold whitespace-nowrap">
      {t('comments.new')}
    </span>
  )
}
