import { defineBrowserCommand } from '@vitest/browser-playwright'

/** A route below the Settings shell, as the production route tree places it. */
export type SettingsRouteNode = {
  id: string
  parentId: string
  /** The route module file, relative to the app directory. */
  file: string
  path?: string
  index?: boolean
}

/**
 * The production Settings route tree below its shell, discovered from the
 * route files on disk. A browser cannot read the files, so it asks for the
 * tree and mounts the real route modules where the tree places them.
 */
export const settingsRouteTree = defineBrowserCommand(async ({ project }) => {
  const { discoverRoutes } =
    await project.import<typeof import('../routes')>('./app/routes.ts')
  type Entry = ReturnType<typeof discoverRoutes>[number]
  const shell = 'routes/_protected/settings/_layout'
  const below = (routes: Entry[], parentId: string): SettingsRouteNode[] =>
    routes.flatMap((route) => [
      {
        id: route.id,
        parentId,
        file: route.file,
        path: route.path,
        index: route.index,
      },
      ...below(route.children ?? [], route.id),
    ])
  const find = (routes: Entry[]): Entry | undefined =>
    routes
      .flatMap((route) => [route, find(route.children ?? [])])
      .find((route) => route?.id === shell)
  const settings = find(discoverRoutes(false))
  if (!settings) throw new Error('The Settings shell route is missing')
  return below(settings.children ?? [], shell)
})

declare module 'vitest/browser' {
  interface BrowserCommands {
    settingsRouteTree: () => Promise<SettingsRouteNode[]>
  }
}
