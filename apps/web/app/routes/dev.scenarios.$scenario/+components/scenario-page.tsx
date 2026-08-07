import { useEffect, useRef } from 'react'
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
  const originalTheme = useRef<string | undefined>(undefined)

  useEffect(() => {
    originalTheme.current = document.documentElement.dataset.theme
    return () => {
      const html = document.documentElement
      if (originalTheme.current === undefined) delete html.dataset.theme
      else html.dataset.theme = originalTheme.current
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div
      data-regression-scenario={scenario}
      className="bg-background text-foreground min-h-dvh"
    >
      <ScenarioContent scenario={scenario} />
    </div>
  )
}
