import { Link } from 'react-router'
import { BrandMark } from '~/components/app/brand-mark'
import { guideFocusRingRoundedClassName } from '~/components/app/guide-styles'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'

export function FocusedFlowBrand() {
  const { t } = useT()
  return (
    <Link
      to="/"
      aria-label={t('vw.homeLink')}
      className={cn(
        'text-foreground mb-4 inline-flex items-center gap-2 self-center text-sm font-semibold no-underline',
        guideFocusRingRoundedClassName,
      )}
    >
      <BrandMark size={16} aria-hidden="true" />
      <span>Artifact Share</span>
    </Link>
  )
}
