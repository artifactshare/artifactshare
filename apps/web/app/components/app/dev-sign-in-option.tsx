import type { ReactNode } from 'react'
import { Form } from 'react-router'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { Button } from '~/components/ui/button'

/**
 * One dev-user picker tile on /dev/sign-in: a full-width outline button with
 * an icon circle + name/note stack, submitting its own one-field form.
 */
export function DevSignInOption({
  next,
  scenario,
  persona,
  icon,
  name,
  note,
}: {
  next: string
  scenario?: string
  persona: 'free-owner' | 'plus-owner' | 'team-owner' | 'team-member'
  icon: ReactNode
  name: string
  note: string
}) {
  return (
    <Form method="post" action="/dev/sign-in">
      <input type="hidden" name="next" value={next} />
      {scenario ? (
        <input type="hidden" name="scenario" value={scenario} />
      ) : null}
      <input type="hidden" name="persona" value={persona} />
      <Button
        type="submit"
        variant="outline"
        className="h-auto min-h-14.5 w-full justify-start gap-3 px-3 py-2 text-left"
      >
        <span
          className="text-muted-foreground bg-surface-warm flex size-8.5 flex-none items-center justify-center rounded-full"
          aria-hidden="true"
        >
          {icon}
        </span>
        <Stack gap="0.5" className="min-w-0 text-left">
          <span className="text-foreground text-sm font-semibold">{name}</span>
          <span className="text-muted-foreground text-xs">{note}</span>
        </Stack>
      </Button>
    </Form>
  )
}
