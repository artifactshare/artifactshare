import { cn } from '~/lib/utils'

export const landingMarkSurfaceClassName = 'mb-5'

export const landingHeroContentOffsetClassName =
  'max-stack:mt-0 mt-[var(--spacing-12)]'

export const landingCrumbMarkClassName = 'inline-block rounded-[var(--r-lg)]'

export const landingBrandClassName =
  'm-0 mb-3 text-5xl font-bold tracking-tight text-foreground leading-[var(--lh-display)]'

export const landingTitleClassName =
  'm-0 mb-4 max-w-landing-title-max text-balance text-3xl font-medium tracking-tight text-muted-foreground leading-[var(--lh-landing-subtitle)]'

export const landingSubClassName =
  'm-0 mb-9 max-w-landing-sub-max text-base leading-[var(--lh-snug)] text-muted-foreground'

export const landingMaintenanceClassName =
  'm-0 mt-4 max-w-landing-maintenance-max text-xs text-muted-foreground'

export const landingDeviceCodeCardSurfaceClassName = cn(
  'border-border bg-muted mb-[var(--spacing-6)] rounded-[var(--r-md)] border',
  'px-[var(--spacing-8)] py-[var(--spacing-5)]',
)

export const landingDeviceCodeLabelClassName =
  'text-xs font-medium uppercase tracking-widest text-faint'

export const landingDeviceCodeClassName =
  'font-mono text-3xl font-semibold tracking-widest text-foreground'

export const landingDeviceStepsClassName = cn(
  'm-0 mb-[var(--spacing-8)] list-none p-0',
  '[&>li+li]:before:block [&>li+li]:before:h-px [&>li+li]:before:w-6',
  '[&>li+li]:before:bg-border-strong [&>li+li]:before:shrink-0',
  '[&>li+li]:before:mx-[var(--spacing-2)] [&>li+li]:before:content-[""]',
)

export const landingDeviceStepSurfaceClassName =
  'text-xs font-medium text-faint'

export const landingDeviceStepActiveClassName = 'text-link'

export const landingDeviceStepNumClassName = cn(
  'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
  'bg-chip-muted text-faint text-xs font-semibold',
)

export const landingDeviceStepNumActiveClassName = 'bg-link-soft text-link'

export const landingAgentBodyClassName = 'mt-[var(--spacing-4)]'

export const landingAgentIntroClassName =
  'm-0 mb-[var(--spacing-5)] text-center text-xs text-muted-foreground'

export const landingRouteCardsClassName = cn(
  'max-nav:grid-cols-1 mb-[var(--spacing-5)] grid w-full grid-cols-2 gap-[var(--spacing-3)]',
)

export const landingRouteCardSurfaceClassName = cn(
  'border-border bg-card min-w-0 rounded-[var(--r-md)] border p-[var(--spacing-4)] text-left',
)

export const landingRouteCardTitleClassName =
  'm-0 min-w-0 text-sm font-semibold text-foreground'

export const landingRouteCardBodyClassName =
  'm-0 flex-1 text-xs text-muted-foreground'

export const landingGuidesClassName = cn(
  'flex flex-wrap justify-center gap-x-[var(--spacing-5)] gap-y-[var(--spacing-3)]',
)

export const landingConnectGuideClassName = cn(
  'text-link text-xs underline underline-offset-2',
  'hover:text-link-hover',
)

export const landingRouteBadgeClassName =
  'min-h-6 px-2.25 py-0.5 font-bold tracking-wide'

export const landingScrollCueClassName = cn(
  'text-faint mt-auto flex flex-col items-center gap-[var(--spacing-1)] pt-6',
  'pb-[var(--spacing-2)] text-xs no-underline transition-colors',
  'hover:text-muted-foreground focus-visible:text-foreground',
)

export const landingProductSectionClassName = cn(
  'border-divider w-full border-t px-6 py-[var(--spacing-16)] text-left',
)

export const landingProductInnerClassName =
  'mx-auto w-full max-w-guide-shell-max'

export const landingProductHeadingClassName =
  'm-0 max-w-landing-title-max text-2xl font-semibold tracking-tight text-foreground leading-tight'

export const landingProductBodyClassName =
  'text-muted-foreground m-0 max-w-landing-sub-max text-sm leading-[var(--lh-loose)]'

export const landingProductIntroBodyClassName =
  'text-muted-foreground m-0 max-w-none text-sm leading-[var(--lh-loose)]'

export const landingProductLinkClassName = cn(
  'text-link inline-flex text-sm font-semibold no-underline',
  'hover:text-link-hover hover:underline hover:underline-offset-3',
)

export const landingProductCtaGroupClassName =
  'flex flex-wrap gap-x-[var(--spacing-5)] gap-y-[var(--spacing-3)]'

export const landingProductCardGridClassName = cn(
  'mt-[var(--spacing-8)] grid grid-cols-3 gap-[var(--spacing-4)]',
  'max-nav:grid-cols-1',
)

export const landingProductStepGridClassName = cn(
  'mt-[var(--spacing-8)] grid grid-cols-3 gap-[var(--spacing-4)]',
  'max-nav:grid-cols-1',
)

export const landingProductCardClassName = cn(
  'border-border bg-card min-w-0 overflow-hidden rounded-[var(--r-lg)] border',
)

export const landingProductCardImageClassName =
  'bg-muted block aspect-4/3 w-full object-cover'

export const landingProductCardContentClassName = cn(
  'flex h-full flex-col gap-[var(--spacing-3)] p-[var(--spacing-5)]',
)

export const landingProductCardLabelClassName =
  'text-link text-xs font-semibold uppercase tracking-widest'

export const landingProductCardTitleClassName =
  'm-0 text-base font-semibold leading-[var(--lh-snug)] text-foreground'

export const landingProductCardBodyClassName =
  'text-muted-foreground m-0 text-sm leading-[var(--lh-loose)]'

export const landingProductSplitClassName = cn(
  'grid grid-cols-2 gap-[var(--spacing-12)]',
  'max-nav:grid-cols-1 max-nav:gap-[var(--spacing-8)]',
)

export const landingProductColumnClassName =
  'flex min-w-0 flex-col items-start gap-[var(--spacing-4)]'
