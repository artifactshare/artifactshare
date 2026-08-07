import type { ReactNode } from 'react'
import { Stack } from '~/components/layout/stack'
import { TeamMutedParagraph } from './team-muted'

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <Stack asChild gap="4">
      <section id={id}>
        <div className="max-stack:flex-col border-divider flex items-start justify-between gap-4 border-b pb-3">
          <div>
            <h2 className="m-0 text-base font-semibold">{title}</h2>
            {description ? (
              <TeamMutedParagraph className="m-0 mt-1">
                {description}
              </TeamMutedParagraph>
            ) : null}
          </div>
          {actions}
        </div>
        {children ? (
          <div className="gap-field flex flex-col">{children}</div>
        ) : null}
      </section>
    </Stack>
  )
}
