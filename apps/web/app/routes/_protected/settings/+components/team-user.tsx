import type { ReactNode } from 'react'

import { TeamMuted } from '~/components/form/team-muted'
import { Stack } from '~/components/layout/stack'

export function TeamUser({
  name,
  email,
}: {
  name: ReactNode
  email?: ReactNode
}) {
  return (
    <Stack gap="0" className="min-w-0">
      <span className="text-foreground truncate font-medium">{name}</span>
      {email ? <TeamMuted>{email}</TeamMuted> : null}
    </Stack>
  )
}
