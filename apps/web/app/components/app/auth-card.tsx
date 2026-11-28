import type { ComponentProps, ReactNode } from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'

export function AuthCard({
  mark = false,
  title,
  sub,
  children,
  footer,
}: {
  mark?: boolean
  title: ReactNode
  sub: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Stack gap="0" align="center" justify="center" asChild>
      <main className="bg-surface-warm flex min-h-screen flex-col">
        <div className="flex w-full flex-1 items-center justify-center px-6 py-12">
          <Stack gap="0" className="w-full max-w-80 text-center">
            {mark ? <FocusedFlowBrand /> : null}
            <h1 className="text-foreground m-0 text-xl font-semibold">
              {title}
            </h1>
            <p className="text-muted-foreground m-0 mt-2 text-xs">{sub}</p>
            {children}
          </Stack>
        </div>
        {footer}
      </main>
    </Stack>
  )
}

export function AuthBlock({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-auth-block-max mx-auto w-full">
      <Stack gap="3">{children}</Stack>
    </div>
  )
}

export function AuthAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mt-4 text-left">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

export function AuthFormStack({ children, ...props }: ComponentProps<'div'>) {
  return (
    <div className="mt-5">
      <Stack gap="2" {...props}>
        {children}
      </Stack>
    </div>
  )
}

export function AuthProviders({ children }: { children: ReactNode }) {
  return <div className="mt-5">{children}</div>
}

export function AuthLinksRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2">
      <Inline gap="4" align="center" justify="between">
        {children}
      </Inline>
    </div>
  )
}

export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5">
      <Inline gap="3" align="center">
        <span className="bg-divider h-px flex-1" />
        <span className="text-faint text-xs tracking-wide whitespace-nowrap uppercase">
          {children}
        </span>
        <span className="bg-divider h-px flex-1" />
      </Inline>
    </div>
  )
}

export function AuthHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mb-1 text-left text-xs">{children}</p>
  )
}

export function AuthFootnote({ children }: { children: ReactNode }) {
  return <div className="mt-5">{children}</div>
}

export function AuthMaintenanceNotice({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground mt-4 text-xs">{children}</p>
}
