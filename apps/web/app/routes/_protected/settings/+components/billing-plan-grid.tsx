import type { ReactNode } from 'react'

export function BillingPlanGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-stretch gap-[var(--spacing-2)] [&_form]:m-0 [&_form]:flex [&_form]:h-full">
      {children}
    </div>
  )
}
