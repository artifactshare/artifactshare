import { scenarioRegistry, type ScenarioId } from './scenarios'

export function ScenarioContent({ scenario }: { scenario: ScenarioId }) {
  const Component = scenarioRegistry[scenario].component
  return <Component />
}
