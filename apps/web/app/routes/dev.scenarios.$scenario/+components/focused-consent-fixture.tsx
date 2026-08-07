import { FocusedFlowBrand } from '~/components/app/focused-flow-brand'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import {
  ConsentActions,
  ConsentDetailList,
  ConsentDetailTerm,
  ConsentDetailValue,
  ConsentScopeList,
} from '~/components/app/consent-panel'
import { Button } from '~/components/ui/button'
import {
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'

export function FocusedConsentFixture() {
  return (
    <LandingShell data-regression-region="main">
      <LandingHero>
        <FocusedFlowBrand />
        <h1 className={landingTitleClassName}>Allow a connector to continue</h1>
        <p className={landingSubClassName}>
          Review the requested access before deciding.
        </p>
        <ConsentDetailList>
          <ConsentDetailTerm>Application</ConsentDetailTerm>
          <ConsentDetailValue>Example Connector</ConsentDetailValue>
          <ConsentDetailTerm>Requested access</ConsentDetailTerm>
          <ConsentDetailValue>
            <ConsentScopeList>
              <li>Read shared artifact metadata</li>
              <li>Publish a new artifact</li>
            </ConsentScopeList>
          </ConsentDetailValue>
        </ConsentDetailList>
        <ConsentActions>
          <Button type="button" data-regression-primary="allow">
            Allow
          </Button>
          <Button type="button" variant="outline">
            Deny
          </Button>
        </ConsentActions>
      </LandingHero>
    </LandingShell>
  )
}
