import type { ComponentProps } from 'react'

import { Stack } from '~/components/layout/stack'
import { cn } from '~/lib/utils'

const landingShellClassName = cn(
  'min-h-screen pt-16 text-center',
  '[background:var(--landing-shell-bg)]',
)

export function LandingShell({
  className,
  children,
  ...props
}: ComponentProps<'main'>) {
  return (
    <Stack gap="0" align="center" asChild>
      <main className={cn(landingShellClassName, className)} {...props}>
        {children}
      </main>
    </Stack>
  )
}

export function LandingHero({
  className,
  children,
  ...props
}: ComponentProps<'div'>) {
  return (
    <Stack
      gap="0"
      align="center"
      justify="center"
      className={cn('w-full flex-1 px-6', className)}
      {...props}
    >
      {children}
    </Stack>
  )
}
