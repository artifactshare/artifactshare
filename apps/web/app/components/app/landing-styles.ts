import { cn } from '~/lib/utils'

export const landingMarkSurfaceClassName = 'mb-5'

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
