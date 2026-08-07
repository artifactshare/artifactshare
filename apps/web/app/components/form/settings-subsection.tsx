import { useId, type ReactNode } from 'react'
import { Stack } from '~/components/layout/stack'
import { settingsSubheadingClassName } from './settings-text-styles'

export function SettingsSubsection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const id = `settings-subsection-${useId()}`
  return (
    <Stack asChild gap="3">
      <section aria-labelledby={id}>
        <h3 id={id} className={settingsSubheadingClassName}>
          {title}
        </h3>
        {children}
      </section>
    </Stack>
  )
}
