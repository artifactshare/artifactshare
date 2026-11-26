import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import {
  AppShell,
  type AppShellData,
  type AppShellHandle,
} from '~/routes/_protected/+components/app-shell'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import type { SettingsLoaderData } from '~/routes/_protected/settings/_layout'

const SHELL: AppShellData = {
  workspaceName: 'Example workspace',
  user: {
    id: 'viewer',
    email: 'viewer@example.test',
    name: 'Viewer',
    image: null,
    initial: 'V',
  },
  joinedProjects: [],
}

/**
 * A page rendered as the router renders it under the signed-in shell: the
 * page's route carries the module's `handle` and its loader data, so the
 * shared header reads them the way it does in the app.
 */
export function renderUnderAppShell(
  page: ReactElement,
  route: { handle: AppShellHandle; loaderData: unknown },
) {
  const router = createMemoryRouter(
    [
      {
        id: 'shell',
        element: (
          <AppShell data={SHELL}>
            <Outlet />
          </AppShell>
        ),
        children: [
          {
            id: 'page',
            path: '*',
            handle: route.handle,
            loader: () => route.loaderData,
            element: page,
          },
        ],
      },
    ],
    { hydrationData: { loaderData: { page: route.loaderData } } },
  )
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

/** Settings as the app renders it: the Settings shell under the app shell. */
export function SettingsUnderAppShell({
  loaderData,
}: {
  loaderData: SettingsLoaderData
}) {
  return (
    <AppShell
      data={{
        ...SHELL,
        workspaceName: loaderData.workspace.name,
        user: loaderData.user,
      }}
    >
      <SettingsLayout loaderData={loaderData} />
    </AppShell>
  )
}
