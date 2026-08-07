import type { ComponentProps, ReactNode } from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'

/**
 * Card frame shared by /sign-in and /dev/sign-in: centers a narrow column on
 * the warm background, then renders an optional full-width footer.
 */
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

/** Sign-in provider block under the landing hero or pre-auth card. */
export function AuthBlock({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-auth-block-max mx-auto w-full">
      <Stack gap="3">{children}</Stack>
    </div>
  )
}

/** Page-level error notice under the card title (provider / send failures). */
export function AuthAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mt-4 text-left">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

/** Vertical rhythm for a form (or form-like) block under the card title/sub. */
export function AuthFormStack({ children, ...props }: ComponentProps<'div'>) {
  return (
    <div className="mt-5">
      <Stack gap="2" {...props}>
        {children}
      </Stack>
    </div>
  )
}

/**
 * Vertical rhythm for the provider group under the card title/sub.
 * AuthBlock owns width (280px) + inner gap for the landing hero and the
 * viewer pre-auth gate; AuthProviders owns only the top rhythm inside
 * AuthCard and has no width constraint.
 */
export function AuthProviders({ children }: { children: ReactNode }) {
  return <div className="mt-5">{children}</div>
}

/** Row of secondary link-style actions (resend / change email). */
export function AuthLinksRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2">
      <Inline gap="4" align="center" justify="between">
        {children}
      </Inline>
    </div>
  )
}

/** "or" divider between the email form and the OAuth provider buttons. */
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

/** Small muted note above the OTP code field ("sent to <email>"). */
export function AuthHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mb-1 text-left text-xs">{children}</p>
  )
}

/** Card footnote rhythm owner for hint / toggle-link blocks after a divider or email form. */
export function AuthFootnote({ children }: { children: ReactNode }) {
  return <div className="mt-5">{children}</div>
}

/** Maintenance-mode notice under the sign-in card. */
export function AuthMaintenanceNotice({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground mt-4 text-xs">{children}</p>
}
