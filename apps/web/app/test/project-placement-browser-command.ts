import { defineBrowserCommand } from '@vitest/browser-playwright'
import type {
  projectPlacementBrowserFixture,
  projectPlacementCandidatesBrowserFixture,
} from './project-placement-browser-fixture'

export const projectPlacementDestinations = defineBrowserCommand(
  async ({ project }, allowOther: boolean) => {
    const fixture = await project.import<
      typeof import('./project-placement-browser-fixture')
    >('./app/test/project-placement-browser-fixture.ts')
    return fixture.projectPlacementBrowserFixture(allowOther)
  },
)

export const projectPlacementCandidates = defineBrowserCommand(
  async ({ project }, allowOther: boolean) => {
    const fixture = await project.import<
      typeof import('./project-placement-browser-fixture')
    >('./app/test/project-placement-browser-fixture.ts')
    return fixture.projectPlacementCandidatesBrowserFixture(allowOther)
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    projectPlacementDestinations: typeof projectPlacementBrowserFixture
    projectPlacementCandidates: typeof projectPlacementCandidatesBrowserFixture
  }
}
