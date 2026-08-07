import { cn } from '~/lib/utils'

export const guideFocusRingClassName =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export const guideFocusRingRoundedClassName = cn(
  guideFocusRingClassName,
  'focus-visible:rounded-[var(--r-sm)]',
)

const guideLinkFocusRingClassName =
  '[&_a:focus-visible]:outline-ring [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2'

const guideLinkFocusRingRoundedClassName = cn(
  guideLinkFocusRingClassName,
  '[&_a:focus-visible]:rounded-[var(--r-sm)]',
)

export const guideMainClassName =
  'min-w-0 max-w-guide-prose-max text-base leading-[var(--lh-prose)]'

export const guideHeroClassName =
  'mb-12 [&_h1]:m-0 [&_h1]:mb-4 [&_h1]:text-4xl [&_h1]:leading-[var(--lh-tight)] [&_h1]:font-bold [&_h1]:tracking-tight max-nav:[&_h1]:text-3xl'

export const guideLeadClassName =
  'm-0 mb-4 text-base leading-[var(--lh-prose)] text-foreground'

export const guideFreshnessClassName = cn(
  'text-muted-foreground mb-4 text-sm leading-[var(--lh-prose)]',
  '[&_p]:m-0 [&_p+p]:mt-1',
)

export const guideSubClassName =
  'm-0 text-base text-muted-foreground [&+&]:mt-1'

export const guideSubInlineLinksClassName = cn(
  guideSubClassName,
  '[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2',
  '[&_a:hover]:text-link-hover',
  guideLinkFocusRingRoundedClassName,
)

export const guideChoiceSectionClassName = 'my-[var(--spacing-10)]'

export const guideChoiceHeadingClassName =
  'mb-[var(--spacing-4)] text-lg font-semibold tracking-normal'

export const guideChoiceGridClassName =
  'grid grid-cols-1 gap-[var(--spacing-3)] lg:grid-cols-2'

export const guideChoiceItemSurfaceClassName = cn(
  'max-nav:p-[var(--spacing-4)] border-border bg-card min-w-0 rounded-[var(--r-lg)] border p-[var(--spacing-5)]',
  'transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none',
  'hover:border-border-strong hover:shadow-[var(--shadow-md)]',
)

export const guideChoiceTitleClassName =
  'min-w-0 text-sm font-emphasis tracking-normal'

export const guideChoiceBodyClassName =
  'm-0 text-sm leading-[var(--lh-prose)] text-muted-foreground'

export const guideSectionClassName = 'relative scroll-mt-scroll-anchor'

export const guideSectionFollowClassName =
  'mt-[var(--spacing-10)] border-t border-border pt-[var(--spacing-10)]'

export const guideNotesSectionClassName =
  'mt-[var(--spacing-12)] scroll-mt-scroll-anchor border-t border-border pt-[var(--spacing-8)]'

export const guideNotesTitleClassName =
  'mb-[var(--spacing-4)] text-lg font-semibold'

export const guideCalloutClassName =
  'grid grid-cols-[18px_minmax(0,1fr)] gap-[var(--spacing-3)] rounded-[var(--r-lg)] border border-border bg-muted px-[var(--spacing-5)] py-[var(--spacing-4)]'

export const guideOfficialInfoSurfaceClassName =
  'flex flex-col gap-4 rounded-[var(--r-lg)] border border-border bg-muted px-[var(--spacing-5)] py-[var(--spacing-4)] [&>p:last-child]:mb-0'

export const guideOfficialInfoGridClassName =
  'max-phone:grid-cols-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--spacing-8)] gap-y-[var(--spacing-3)]'

export const guideCalloutIconClassName = 'mt-0.5 text-muted-foreground'

export const guideCalloutTitleClassName =
  'mb-[var(--spacing-1)] text-sm font-semibold text-foreground'

export const guideCalloutBodyClassName =
  'm-0 text-sm leading-[var(--lh-prose)] text-muted-foreground'

export const guideStepExtraClassName = 'mt-[var(--spacing-2)]'

export const guideStepSubstepsClassName =
  'mt-[var(--spacing-2)] mb-0 list-disc pl-6 text-muted-foreground [&>li]:my-1'

export const guideStepLinkClassName = cn(
  'text-link ml-[var(--spacing-1)] underline underline-offset-3',
  'hover:text-link-hover',
  guideFocusRingRoundedClassName,
)

export const guideStepsClassName = cn(
  'm-0 list-none p-0 [counter-reset:guidestep]',
  '[&>li]:relative [&>li]:grid [&>li]:grid-cols-[26px_minmax(0,1fr)] [&>li]:gap-[var(--spacing-3)] [&>li]:pb-[var(--spacing-5)]',
  '[&>li:last-child]:pb-0',
  '[&>li]:[counter-increment:guidestep]',
  '[&>li]:before:size-control-sm [&>li]:before:relative [&>li]:before:z-1 [&>li]:before:inline-grid [&>li]:before:place-items-center',
  '[&>li]:before:bg-link-soft [&>li]:before:text-link [&>li]:before:rounded-full [&>li]:before:text-xs [&>li]:before:leading-none [&>li]:before:font-semibold',
  '[&>li]:before:content-[counter(guidestep)]',
  '[&>li:not(:last-child)]:after:top-control-sm [&>li:not(:last-child)]:after:absolute [&>li:not(:last-child)]:after:bottom-0.5 [&>li:not(:last-child)]:after:left-3',
  '[&>li:not(:last-child)]:after:bg-link-soft [&>li:not(:last-child)]:after:w-0.5 [&>li:not(:last-child)]:after:content-[""]',
)

export const guideLanguageSwitcherLinksClassName = cn(
  'text-muted-foreground border-border border-t pt-5 text-sm',
  '[&_a]:text-muted-foreground [&_a]:no-underline',
  '[&_a:hover]:text-foreground [&_a:hover]:underline [&_a:hover]:underline-offset-2',
  guideLinkFocusRingRoundedClassName,
  '[&_[aria-current]]:text-foreground [&_[aria-current]]:font-semibold',
)

export const guideTocMobileSurfaceClassName = cn(
  'mt-8 mb-8 hidden max-lg:flex',
  '[&_a]:text-muted-foreground [&_a]:px-guide-toc-inline [&_a]:border-border [&_a]:bg-card [&_a]:inline-flex [&_a]:min-h-8 [&_a]:items-center [&_a]:rounded-[var(--r-md)] [&_a]:border [&_a]:py-1 [&_a]:text-sm [&_a]:font-medium [&_a]:no-underline',
  guideLinkFocusRingClassName,
)

export const guideRailNavSurfaceClassName = cn(
  'border-border border-l',
  '[&_a]:text-muted-foreground [&_a]:py-guide-rail-pad-block [&_a]:-ml-px [&_a]:border-l-2 [&_a]:border-transparent [&_a]:px-3 [&_a]:text-sm [&_a]:no-underline',
  '[&_a]:transition-colors [&_a]:duration-[var(--duration-fast)] [&_a]:ease-[var(--ease-out)]',
  '[&_a:hover]:text-foreground',
  '[&_a[aria-current=true]]:border-l-link [&_a[aria-current=true]]:text-link [&_a[aria-current=true]]:font-medium',
  guideLinkFocusRingClassName,
)
