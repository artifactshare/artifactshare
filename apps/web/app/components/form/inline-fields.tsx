import type { ReactNode } from 'react'

export function InlineFields({ children }: { children: ReactNode }) {
  return (
    <div className="gap-inline max-stack:flex-col max-stack:items-stretch flex items-center [&>:not([data-slot=field])]:shrink-0">
      {children}
    </div>
  )
}
