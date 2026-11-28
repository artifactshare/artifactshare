import { resolvePath } from 'react-router'
import { isViteDev } from '~/lib/is-vite-dev'
import {
  SETTINGS_PAGE_PATHS,
  SETTINGS_STATE_IDS,
  SETTINGS_STATES,
  type SettingsPageId,
} from './dev.settings.$state/+components/settings-states'
import {
  SCENARIO_IDS,
  scenarioRegistry,
} from './dev.scenarios.$scenario/+components/scenarios'

export function loader() {
  if (!isViteDev()) throw new Response(null, { status: 404 })
  return Response.json({
    screens: [
      ...SETTINGS_STATE_IDS.flatMap((state) => {
        const { description, pages } = SETTINGS_STATES[state]
        return (Object.keys(SETTINGS_PAGE_PATHS) as SettingsPageId[])
          .filter((page) => page in pages)
          .map((page) => ({
            id: `${page.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-${state}`,
            path: resolvePath(
              SETTINGS_PAGE_PATHS[page],
              `/dev/settings/${state}`,
            ).pathname,
            description,
          }))
      }),
      ...SCENARIO_IDS.map((scenario) => ({
        id: `scenario-${scenario}`,
        path: `/dev/scenarios/${scenario}`,
        description: scenarioRegistry[scenario].title,
        themeParameter: true,
      })),
    ],
  })
}
