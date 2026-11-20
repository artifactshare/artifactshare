import { expect, test, vi } from 'vitest'
vi.stubGlobal('__VISUAL_FAULT__', null)
vi.mock('~/routes/dev.scenarios.$scenario/+components/scenarios', () => {
  const ids = [
    'settings-menu-open',
    'settings-menu-free-owner',
    'settings-menu-team-admin',
    'settings-menu-team-member',
    'search-mobile-search',
  ]
  return {
    SCENARIO_IDS: ids,
    scenarioRegistry: Object.fromEntries(
      ids.map((id) => [id, { requiredRegions: [] }]),
    ),
  }
})
const { SCENARIO_CONDITIONS } = await import('./scenario-regression-contract')
test('settings sheet only runs on mobile while all role menus retain both widths', () => {
  for (const scenario of [
    'settings-menu-open',
    'settings-menu-free-owner',
    'settings-menu-team-admin',
    'settings-menu-team-member',
  ]) {
    expect(
      SCENARIO_CONDITIONS.filter((c) => c.scenario === scenario).map(
        (c) => `${c.viewport}/${c.theme}`,
      ),
    ).toEqual(
      scenario === 'settings-menu-open'
        ? ['mobile/light', 'mobile/dark']
        : ['mobile/light', 'mobile/dark', 'desktop/light', 'desktop/dark'],
    )
  }
  expect(
    SCENARIO_CONDITIONS.filter(
      (c) => c.scenario === 'search-mobile-search',
    ).some((c) => c.viewport === 'desktop'),
  ).toBe(false)
})
