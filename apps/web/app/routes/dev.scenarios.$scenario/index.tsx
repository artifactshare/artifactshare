import { Link, useParams, useSearchParams } from 'react-router'
import { isViteDev } from '~/lib/is-vite-dev'
import { ScenarioPage } from './+components/scenario-page'
import {
  isScenarioId,
  SCENARIO_IDS,
  type ScenarioId,
  scenarioRegistry,
} from './+components/scenarios'

const THEMES = ['light', 'dark'] as const
export type RegressionTheme = (typeof THEMES)[number]

export function parseTheme(value: string | null): RegressionTheme {
  return value === 'dark' ? 'dark' : 'light'
}

export function loader({ params }: { params: { scenario?: string } }) {
  if (!isViteDev() || !isScenarioId(params.scenario)) {
    throw new Response(null, { status: 404 })
  }
  return { scenario: params.scenario }
}

export function meta() {
  return [{ title: 'Product shell regression scenarios' }]
}

export default function DevScenario() {
  const { scenario } = useParams<{ scenario: string }>()
  const [searchParams] = useSearchParams()

  if (!isScenarioId(scenario)) return null

  return (
    <>
      <Link
        to={`/dev/scenarios/${scenario === 'landing-default' ? 'viewer-default' : 'landing-default'}?theme=${parseTheme(searchParams.get('theme'))}`}
        data-regression-route-link
        aria-hidden="true"
        tabIndex={-1}
        className="fixed top-0 left-0 size-px opacity-0"
      />
      <ScenarioPage
        scenario={scenario}
        theme={parseTheme(searchParams.get('theme'))}
      />
    </>
  )
}

export {
  ScenarioPage,
  SCENARIO_IDS,
  scenarioRegistry,
  isScenarioId,
  type ScenarioId,
}
