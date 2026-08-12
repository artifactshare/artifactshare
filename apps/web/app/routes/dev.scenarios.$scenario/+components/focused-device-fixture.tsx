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
      <LandingHero>
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
          <FieldLabel htmlFor="fixture-agent-project">
            Project this agent can work in
          </FieldLabel>
          <select
            id="fixture-agent-project"
            defaultValue="design"
            className="border-input bg-background h-10 rounded-md border px-3"
          >
            <option value="design">Design review</option>
            <option value="docs">Documentation</option>
          </select>
        </Field>
        <ConsentActions>
          <Button type="button" data-regression-primary="approve">
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
