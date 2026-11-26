import { isViteDev } from '~/lib/is-vite-dev'
import {
  BILLING_STATE_IDS,
  BILLING_STATES,
} from './dev.settings.$state/+components/billing-states'
import {
  SCENARIO_IDS,
  scenarioRegistry,
} from './dev.scenarios.$scenario/+components/scenarios'

/**
 * Development only: every fixture screen the dev server can show, so
 * `pnpm screens` captures them without a list of its own.
 */
export function loader() {
  if (!isViteDev()) throw new Response(null, { status: 404 })
  return Response.json({
    screens: [
      ...BILLING_STATE_IDS.map((state) => ({
        id: `billing-${state}`,
        path: `/dev/settings/${state}/billing`,
        description: BILLING_STATES[state].description,
      })),
      ...SCENARIO_IDS.map((scenario) => ({
        id: `scenario-${scenario}`,
        path: `/dev/scenarios/${scenario}`,
        description: scenarioRegistry[scenario].title,
        // Scenarios take their theme from this parameter, not the cookie.
        themeParameter: true,
      })),
    ],
  })
}
