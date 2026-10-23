import en from '~/i18n/en.json'
import { Stack } from '~/components/layout/stack'
import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import { ConsentActions } from '~/components/app/consent-panel'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Button } from '~/components/ui/button'
import { FixtureFooter } from './fixture-footer'
import {
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'

export function FocusedDeviceFixture() {
  return (
    <LandingShell data-regression-region="main">
      <LandingHero className="pb-6">
        <FocusedFlowBrand />
        <h1 className={landingTitleClassName}>CLI sign-in</h1>
        <p className={landingSubClassName}>
          Enter the code shown in your terminal, or check that it matches the
          code below. Approval lets the CLI use the account signed in to this
          browser.
        </p>
        <Field className="max-w-80">
          <FieldLabel htmlFor="fixture-device-code">Code</FieldLabel>
          <Input
            id="fixture-device-code"
            defaultValue="ABCD-1234"
            inputMode="text"
            autoComplete="one-time-code"
            className="h-14 text-center font-mono text-2xl"
          />
        </Field>
        <Field className="mt-4 max-w-80">
          <FieldLabel id="fixture-agent-project-label">
            Posting project
          </FieldLabel>
          <div
            id="fixture-agent-project"
            aria-labelledby="fixture-agent-project-label"
            className="border-border bg-muted/30 rounded-md border px-3 py-2 text-sm"
          >
            Design review
          </div>
          <p className="text-muted-foreground text-sm">
            Approving lets this agent post only to “Design review”. It can also
            read workspace-visible files and private projects shared with you.
          </p>
        </Field>
        <div className="mt-4 w-full max-w-80 text-left text-sm">
          <Stack gap="3">
            <p role="note" className="font-medium">
              {en['device.approval_warning']}
            </p>
            <label
              htmlFor="fixture-code-confirmation"
              className="flex min-h-11 cursor-pointer items-start gap-2 py-2"
            >
              <input
                id="fixture-code-confirmation"
                type="checkbox"
                className="accent-primary focus-visible:ring-ring mt-1 size-4 shrink-0 focus-visible:ring-2 focus-visible:ring-offset-2"
              />
              <span>{en['device.code_confirmation']}</span>
            </label>
          </Stack>
        </div>
        <ConsentActions>
          <Button type="button" disabled data-regression-primary="approve">
            Approve
          </Button>
          <Button type="button" variant="outline">
            Deny
          </Button>
        </ConsentActions>
      </LandingHero>
      <FixtureFooter variant="minimal" />
    </LandingShell>
  )
}
