import { Link, useLocation } from 'react-router'
import type { ComponentProps, ReactNode } from 'react'

import {
  guideFocusRingRoundedClassName,
  guideMainClassName,
} from '~/components/app/guide-styles'
import { BrandMark } from '~/components/app/brand-mark'
import { Inline } from '~/components/layout/inline'
import { cn } from '~/lib/utils'
import { useT } from '~/hooks/use-t'
import { withLang } from '~/lib/connect-link'

const guideShellGridClassName =
  'mx-auto grid max-w-guide-shell-max items-start gap-16 px-6 pt-16 pb-24 text-foreground max-lg:grid-cols-1 max-lg:gap-0 max-lg:pt-10'

export function GuideTopbar({
  className,
  children,
  ...props
}: {
  className?: string
  children: ReactNode
  id?: ComponentProps<'header'>['id']
  'aria-labelledby'?: ComponentProps<'header'>['aria-labelledby']
  'data-regression-region'?: string
}) {
  const { locale, t } = useT()
  const { pathname } = useLocation()
  const publicPath =
    pathname.replace(/^\/ja(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  return (
    <header
      className={cn(
        'sticky top-0 z-[var(--z-topbar)] flex min-h-12 items-center px-6',
        'max-nav:flex-wrap max-nav:gap-y-2 max-nav:py-2',
        'border-divider border-b',
        'bg-[color-mix(in_srgb,var(--background)_88%,transparent)]',
        'supports-backdrop-filter:backdrop-blur-sm supports-backdrop-filter:backdrop-saturate-180',
        className,
      )}
      {...props}
    >
      <div className="min-w-0 shrink-0">{children}</div>
      <nav
        aria-label={t('footer.colProduct')}
        className="ml-auto flex shrink-0 items-center gap-3 text-xs"
      >
        <Link
          to={withLang('/share-with-ai', locale)}
          aria-current={publicPath === '/share-with-ai' ? 'page' : undefined}
          className={cn(
            'whitespace-nowrap hover:opacity-70',
            guideFocusRingRoundedClassName,
          )}
        >
          {t('publicHeader.shareWithAi')}
        </Link>
        <Link
          to={withLang('/pricing', locale)}
          aria-current={publicPath === '/pricing' ? 'page' : undefined}
          className={cn(
            'whitespace-nowrap hover:opacity-70',
            guideFocusRingRoundedClassName,
          )}
        >
          {t('publicHeader.pricing')}
        </Link>
      </nav>
    </header>
  )
}

export function GuideHomeLink({
  homeLabel,
  label = 'Artifact Share',
}: {
  homeLabel: string
  label?: string
}) {
  return (
    <Inline gap="2" align="center" asChild>
      <Link
        to="/"
        aria-label={homeLabel}
        className={cn(
          'text-foreground text-sm font-semibold no-underline hover:opacity-70',
          guideFocusRingRoundedClassName,
        )}
      >
        <BrandMark size={16} aria-hidden="true" />
        <span>{label}</span>
      </Link>
    </Inline>
  )
}

export function GuideShell({
  prose,
  children,
  className,
}: {
  prose?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <main
      data-guide
      className={cn(
        guideShellGridClassName,
        prose
          ? 'max-w-guide-shell-prose-max grid-cols-1 gap-0'
          : 'grid-cols-[minmax(0,1fr)_200px]',
        className,
      )}
    >
      {children}
    </main>
  )
}

export function GuideMain({
  className,
  children,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div className={cn(guideMainClassName, className)} {...props}>
      {children}
    </div>
  )
}

const guideProseClassName = cn(
  guideMainClassName,
  '[&_h1]:m-0 [&_h1]:mb-6 [&_h1]:text-3xl [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-tight',
  '[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_p]:text-muted-foreground [&_p]:m-0 [&_p]:mb-4',
  '[&_strong]:text-foreground',
  '[&_ul]:text-muted-foreground [&_ul]:m-0 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6',
  '[&_ol]:text-muted-foreground [&_ol]:m-0 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6',
  '[&_li]:my-1',
  '[&_a:not([data-slot=button])]:text-link [&_a:not([data-slot=button])]:underline [&_a:not([data-slot=button])]:underline-offset-2',
  '[&_a:not([data-slot=button]):hover]:text-link-hover',
  '[&_a:not([data-slot=button]):focus-visible]:outline-ring [&_a:not([data-slot=button]):focus-visible]:rounded-[var(--r-sm)] [&_a:not([data-slot=button]):focus-visible]:outline-2 [&_a:not([data-slot=button]):focus-visible]:outline-offset-2',
  '[&_code]:text-foreground [&_code]:px-code-inline [&_code]:bg-accent [&_code]:rounded-[var(--r-sm)] [&_code]:py-px [&_code]:font-mono [&_code]:[font-size:var(--text-size-code)]',
  '[&_pre]:border-border [&_pre]:bg-muted [&_pre]:m-0 [&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--r-md)] [&_pre]:border [&_pre]:px-4 [&_pre]:py-3 [&_pre]:[font-size:var(--text-size-code)] [&_pre]:leading-[var(--lh-loose)]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:[font-size:inherit]',
  '[&_code.block+p]:mt-[var(--spacing-3)]',
  '[&_blockquote]:text-muted-foreground [&_blockquote]:border-border [&_blockquote]:bg-muted [&_blockquote]:my-4 [&_blockquote]:rounded-r-[var(--r-md)] [&_blockquote]:border-l-3 [&_blockquote]:px-4 [&_blockquote]:py-3',
  '[&_hr]:border-border [&_hr]:m-0 [&_hr]:my-8 [&_hr]:border-0 [&_hr]:border-t',
)

export function GuideProse({
  className,
  children,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div className={cn(guideProseClassName, className)} {...props}>
      {children}
    </div>
  )
}
