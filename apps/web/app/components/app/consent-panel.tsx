import type { ReactNode } from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'

/**
 * Shared detail/status/actions display for the device-authorization and
 * OAuth-consent screens (`device.tsx` / `consent.tsx`), both built on the
 * landing shell chrome. Each piece owns its own spacing so the routes stay
 * free of layout utilities.
 */

export function ConsentDetailList({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-2 mb-1 grid w-full max-w-90 gap-1.5 text-left">
      {children}
    </dl>
  )
}

export function ConsentDetailTerm({ children }: { children: ReactNode }) {
  return <dt className="text-muted-foreground text-xs">{children}</dt>
}

export function ConsentDetailValue({ children }: { children: ReactNode }) {
  return <dd className="text-foreground break-all">{children}</dd>
}

export function ConsentScopeList({ children }: { children: ReactNode }) {
  return <ul className="m-0 grid gap-0.5 pl-4.5">{children}</ul>
}

/** Plain informational status line (checking / already handled / done). */
export function ConsentStatusText({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mt-2 mb-1 w-full max-w-90 text-left text-sm">
      {children}
    </p>
  )
}

export function ConsentErrorAlert({
  id,
  children,
}: {
  id?: string
  children: ReactNode
}) {
  return (
    <Alert
      variant="destructive"
      id={id}
      className="mt-2 mb-1 w-full max-w-90 text-left"
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

export function ConsentActions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex items-center gap-2.5">{children}</div>
}
