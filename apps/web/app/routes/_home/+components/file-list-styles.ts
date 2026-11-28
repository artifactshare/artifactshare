import { cn } from '~/lib/utils'

export const homeSectionClassName = 'mb-4.5'
export const homeHeadClassName =
  'flex items-center justify-between gap-3 max-stack:flex-col max-stack:items-start'
export const homeHeadTitleClassName =
  'm-0 text-xl font-emphasis leading-tight text-foreground'
export const homeActionsClassName = 'flex shrink-0 items-center gap-2'
export const projectMetaClassName = 'mt-1 text-xs text-muted-foreground'

export const fileTableColumns =
  'grid-cols-[minmax(280px,1fr)_112px_90px_120px_minmax(120px,0.35fr)_36px]'
export const filesTableColumns =
  'grid-cols-[minmax(280px,1fr)_112px_90px_120px_36px]'
export const fileTableColumnsActions =
  'grid-cols-[minmax(280px,1fr)_112px_90px_120px_minmax(120px,0.35fr)_76px]'
export const filesTableColumnsActions =
  'grid-cols-[minmax(280px,1fr)_112px_90px_120px_76px]'
export const groupedFileTableColumns =
  'grid-cols-[minmax(280px,1fr)_190px_120px_minmax(120px,0.35fr)_36px]'
export const groupedFilesTableColumns =
  'grid-cols-[minmax(280px,1fr)_190px_120px_36px]'
export const groupedFileTableColumnsActions =
  'grid-cols-[minmax(280px,1fr)_190px_120px_minmax(120px,0.35fr)_76px]'
export const groupedFilesTableColumnsActions =
  'grid-cols-[minmax(280px,1fr)_190px_120px_76px]'
export const homeCompactFilesColumns =
  'grid-cols-[minmax(0,1fr)_40px] @min-[theme(--breakpoint-stack)]:grid-cols-[minmax(0,1fr)_190px_120px_76px]'
export const homeCompactLostAccessColumns = 'grid-cols-[minmax(0,1fr)]'
export const dateRailFilesColumns =
  '@max-recent-rail-collapse:grid-cols-[minmax(0,1fr)_40px] @min-recent-rail-collapse:@max-recent-rail-wide:grid-cols-[3.5rem_minmax(0,1fr)_40px] @min-recent-rail-wide:grid-cols-[6rem_minmax(0,1fr)_9rem_5.5rem_76px]'
export const dateRailRestrictedColumns =
  '@max-recent-rail-collapse:grid-cols-[minmax(0,1fr)] @min-recent-rail-collapse:@max-recent-rail-wide:grid-cols-[3.5rem_minmax(0,1fr)] @min-recent-rail-wide:grid-cols-[6rem_minmax(0,1fr)_calc(9rem+5.5rem+76px+2rem)]'
export const projectFileColumns =
  'grid-cols-[minmax(0,1fr)_auto_76px] max-wide:grid-cols-[minmax(0,1fr)_auto_76px]'
export const fileTableListClassName =
  'flex flex-col gap-1 border-t border-divider'
export const fileTableHeadClassName =
  'max-wide:hidden text-faint box-border grid min-h-8.5 items-center gap-4 px-3 text-xs font-medium'
export const fileDateHeadingClassName =
  'text-faint mt-4 mb-1 px-3 text-xs font-normal'

export const sectionClassName = 'mb-6'
export const sectionHeadClassName = 'flex items-center justify-between mb-2'
export const sectionTitleClassName =
  'inline-flex items-baseline gap-2 text-sm font-semibold text-foreground'
export const sectionCountClassName = 'text-xs font-medium text-faint'
export const seeAllClassName =
  'text-sm text-muted-foreground no-underline hover:text-foreground after:content-["_→"]'
