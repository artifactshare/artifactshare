import { Link, useLocation } from 'react-router'
import { useHydrated } from '~/hooks/use-hydrated'
import { useT } from '~/hooks/use-t'
import { BrandMark } from '~/components/app/brand-mark'
import { guideFocusRingClassName } from '~/components/app/guide-styles'
import { cn } from '~/lib/utils'
import { withLang } from '~/lib/connect-link'
import {
  hasViewerReturnContext,
  viewerReturnState,
  viewerReturnTo,
} from '~/lib/viewer-return'
import { IconChevronLeft } from '@tabler/icons-react'

export function ViewerNav({
  anonymous = false,
  variant = 'viewer',
  className,
}: {
  anonymous?: boolean
  // viewer-brand-placement.md: 閲覧エラーページは本文閲覧の情報量を持たないため
  // ロゴを 16px / 48px バーに揃える (通常 viewer は文字併記 20px / 単独 24px)
  variant?: 'viewer' | 'error'
  className?: string
}) {
  const { locale, t } = useT()
  const location = useLocation()
  const hydrated = useHydrated()
  const hasReturnContext = hydrated && hasViewerReturnContext(location.state)
  const returnTo = viewerReturnTo(location.state)
  const navClassName = cn('inline-flex shrink-0 items-center gap-1', className)
  const homeClassName = cn(
    'text-muted-foreground hover:bg-accent hover:text-foreground max-phone:gap-0 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-sm font-semibold no-underline',
    guideFocusRingClassName,
    variant === 'error' && 'text-foreground max-phone:gap-2 gap-2',
  )
  const markSize = variant === 'error' ? 16 : 20
  const markClassName =
    variant === 'error'
      ? undefined
      : 'max-phone:size-6 [[data-solo=true]_&]:size-6'
  const homeNameClassName = variant === 'error' ? '' : 'max-phone:hidden'
  const backClassName =
    'text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] px-2 text-sm no-underline max-nav:px-2 max-nav:[&>span]:hidden max-phone:size-touch-target max-phone:justify-center max-phone:p-0'
  if (anonymous) {
    return (
      <div className={navClassName}>
        <Link
          to={withLang('/', locale)}
          className={homeClassName}
          aria-label={t('vw.homeLink')}
        >
          <BrandMark
            size={markSize}
            className={markClassName}
            aria-hidden="true"
          />
          <span className={homeNameClassName}>Artifact Share</span>
        </Link>
      </div>
    )
  }

  return (
    <div className={navClassName}>
      <Link
        to="/"
        className={homeClassName}
        data-solo={hasReturnContext ? true : undefined}
        viewTransition
        aria-label={t('vw.homeLink')}
      >
        <BrandMark
          size={markSize}
          className={markClassName}
          aria-hidden="true"
        />
        {hasReturnContext ? null : (
          <span className={homeNameClassName}>Artifact Share</span>
        )}
      </Link>
      {hasReturnContext ? (
        <Link
          to={returnTo}
          replace
          state={viewerReturnState()}
          viewTransition
          className={backClassName}
          aria-label={t('vw.back')}
        >
          <IconChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('vw.back')}</span>
        </Link>
      ) : null}
    </div>
  )
}
