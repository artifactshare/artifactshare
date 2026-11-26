import { resolvePath } from 'react-router'
import { expect, test } from 'vitest'
import { discoveredRoutes, resolveRoute } from '~/test/discovered-routes'
import { settingsNavGroups } from '~/routes/_protected/settings/+components/settings-nav'
import {
  SETTINGS_PAGE_PATHS,
  SETTINGS_STATE_IDS,
  SETTINGS_STATES,
  type SettingsPageId,
} from './settings-states'

const pagesOf = (state: keyof typeof SETTINGS_STATES) =>
  Object.keys(SETTINGS_STATES[state].pages) as SettingsPageId[]

// A Settings page added to the menu fails here until these states give it
// fixture data, so every page stays reachable on the dev server.
test.each(['free', 'team-subscribed', 'team-member'] as const)(
  '%s covers exactly the pages its Settings menu shows',
  (state) => {
    const { shell } = SETTINGS_STATES[state]
    const menu = settingsNavGroups({
      currentUserIsAdmin: shell.currentUserIsAdmin,
      workspaceKind: shell.kind,
    }).flatMap((group) => group.items.map((item) => item.to))
    const covered = pagesOf(state).map(
      (page) => SETTINGS_PAGE_PATHS[page].split('/')[0],
    )
    expect(new Set(covered)).toEqual(new Set(menu))
  },
)

test('each fixture page opens the dev route that mirrors its Settings route', () => {
  const routes = discoveredRoutes(true)
  const leaf = (url: string) => resolveRoute(routes, url).ids?.at(-1)
  for (const state of SETTINGS_STATE_IDS)
    for (const page of pagesOf(state)) {
      const path = SETTINGS_PAGE_PATHS[page]
      const dev = leaf(resolvePath(path, `/dev/settings/${state}`).pathname)
      expect(dev, `${state} ${page}`).toMatch(
        /^routes\/dev\.settings\.\$state\//,
      )
      expect(
        dev?.replace('dev.settings.$state/', '_protected/settings/_content/'),
        `${state} ${page}`,
      ).toBe(leaf(resolvePath(path, '/settings').pathname))
    }
})
