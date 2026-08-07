import { cn } from '~/lib/utils'

export const authProviderButtonClassName = cn(
  'text-foreground border-border bg-card h-10 w-full cursor-pointer gap-[var(--spacing-2)] rounded-[var(--r-md)] px-[var(--spacing-4)] text-sm font-medium shadow-none',
  'dark:border-border dark:bg-card',
  'transition-[background] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none',
  'hover:text-foreground hover:bg-accent dark:hover:bg-accent',
  // Button base の active:not-aria-[haspopup]:translate-y-px と同じ modifier
  // 連鎖で書かないと tailwind-merge が畳まず、詳細度でも負けて 1px 沈む。
  'active:not-aria-[haspopup]:translate-y-0',
  // Button base の disabled:pointer-events-none を戻さないと cursor が効かない
  // (クリック自体は disabled 属性が止める)。
  'disabled:hover:bg-card disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-50',
  '[&_svg]:shrink-0',
)

export const authEmailLinkClassName = cn(
  'text-muted-foreground cursor-pointer self-center border-0 bg-transparent text-xs no-underline',
  'hover:text-foreground hover:underline hover:underline-offset-3',
)

export const preauthMainClassName = cn(
  'bg-surface-warm min-h-screen p-[var(--spacing-6)]',
)

export const preauthCardClassName =
  'flex max-w-preauth-max flex-col items-center gap-[var(--spacing-3)] text-center'

export const preauthLockIconClassName = cn(
  'text-muted-foreground border-border bg-card inline-flex size-8 items-center justify-center rounded-[var(--r-md)] border',
  '[&_svg]:size-icon-auth',
)

export const preauthTitleClassName =
  'm-0 mt-[var(--spacing-2)] text-xl font-semibold text-foreground'

export const preauthSubClassName =
  'm-0 text-xs leading-[var(--lh-loose)] text-muted-foreground'

export const preauthFooterLinksClassName = cn(
  'text-muted-foreground text-center text-xs',
  '[&_a]:text-muted-foreground [&_a]:no-underline',
  '[&_a:hover]:text-foreground [&_a:hover]:underline',
)

export const preauthAgentBodyClassName = cn(
  'border-border bg-card mt-[var(--spacing-3)] rounded-[var(--r-md)] border p-[var(--spacing-3)]',
  '[&_p]:text-muted-foreground [&_p]:m-0 [&_p]:text-xs',
  '[&_p+p]:mt-[var(--spacing-2)]',
  '[&_strong]:text-foreground [&_strong]:font-semibold [&_strong]:after:content-[":_"]',
)
