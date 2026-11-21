import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'

import { TeamMuted } from '~/components/form/team-muted'
import { Stack } from '~/components/layout/stack'

export function TeamUser({
  name,
  email,
  wrapOnPhone = false,
}: {
  name: ReactNode
  email?: ReactNode
  wrapOnPhone?: boolean
}) {
  return (
    <Stack gap="0" className="min-w-0">
      <span
        className={cn(
          'text-foreground truncate font-medium',
          wrapOnPhone &&
            'max-md:overflow-visible max-md:[overflow-wrap:anywhere] max-md:whitespace-normal',
        )}
      >
        {name}
      </span>
      {email ? (
        <TeamMuted
          className={cn(
            wrapOnPhone &&
              'max-md:overflow-visible max-md:[overflow-wrap:anywhere] max-md:break-all max-md:whitespace-normal',
          )}
        >
          {email}
        </TeamMuted>
      ) : null}
    </Stack>
  )
}
