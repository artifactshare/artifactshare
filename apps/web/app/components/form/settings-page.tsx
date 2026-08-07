import type { ReactNode } from 'react'

export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="gap-section flex flex-col">{children}</div>
}
