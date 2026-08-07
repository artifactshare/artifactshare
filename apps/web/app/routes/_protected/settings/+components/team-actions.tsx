import type { ReactNode } from 'react'

export function TeamActions({ children }: { children: ReactNode }) {
  return (
    <div className="max-stack:flex-wrap max-stack:justify-start flex justify-end gap-[var(--spacing-2)] [&_form]:m-0">
      {children}
    </div>
  )
}
