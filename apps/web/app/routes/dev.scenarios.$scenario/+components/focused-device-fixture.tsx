import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import { ConsentActions } from '~/components/app/consent-panel'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Button } from '~/components/ui/button'
import { ProjectCandidateLabel } from '~/components/app/project-candidate-picker'
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
            role="group"
            className="grid gap-[var(--spacing-2)]"
            aria-labelledby="fixture-agent-project-label"
          >
            <button
              type="button"
              aria-pressed="true"
              className="border-ring bg-muted focus-visible:ring-ring min-h-11 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-3"
            >
              <ProjectCandidateLabel
                project={{
                  id: 'design-review',
                  name: 'Design review',
                  baseVisibility: 'workspace',
                  updatedAt: '2026-08-23T12:00:00.000Z',
                }}
                locale="en"
                preferred
              />
            </button>
            <button
              type="button"
              aria-pressed="false"
              className="border-border bg-background hover:bg-muted focus-visible:ring-ring min-h-11 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-3"
            >
              <ProjectCandidateLabel
                project={{
                  id: 'documentation',
                  name: 'Documentation',
                  baseVisibility: 'private',
                  updatedAt: '2026-08-22T12:00:00.000Z',
                }}
                locale="en"
              />
            </button>
          </div>
          <p className="text-muted-foreground text-sm">
            Approving lets this agent post only to “Design review”. It can also
            read workspace-visible files and private projects shared with you.
          </p>
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
