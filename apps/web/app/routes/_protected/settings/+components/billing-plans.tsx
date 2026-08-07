import type { ReactNode } from 'react'

export function BillingPlans({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--spacing-4)] [&_h3]:m-0 [&_h3]:text-sm [&_h3]:font-semibold [&_p]:m-0 [&_p]:overflow-visible [&_p]:text-clip [&_p]:whitespace-normal">
      {children}
    </div>
  )
}
