import { useDocumentAttribute } from '~/hooks/use-document-attribute'
import { ScenarioContent } from './scenario-content'
import type { RegressionTheme } from '../index'
import type { ScenarioId } from './scenarios'

export function ScenarioPage({
  scenario,
  theme = 'light',
}: {
  scenario: ScenarioId
  theme?: RegressionTheme
}) {
  useDocumentAttribute('data-theme', theme)

  return (
    <div
      data-regression-scenario={scenario}
      className="bg-background text-foreground min-h-dvh"
    >
      <ScenarioContent scenario={scenario} />
    </div>
  )
}
