import { workspaceSearchIndex } from './search-index/names'
import { searchVisibilitySources } from './search-visibility.server'
export async function ensureDevSignInUser(
  env: Env,
  db: Database,
  userId: string,
  workspaceId: string,
  scenario: string | undefined,
  now: number,
) {
  if (scenario?.startsWith('search/')) {
    // Captures search every workspace the viewer can see, as the product does.
    // Each index must have applied its pending changes; otherwise the product
    // marks results incomplete and the captured states lose their own UI.
    const sources = await searchVisibilitySources(db, userId, {}, now)
    let found = false
    for (let attempt = 1; ; attempt++) {
      const pages = await Promise.all(
        sources.map(async ({ workspaceId: workspace, visibility }) => {
          const index = workspaceSearchIndex(
            env.WORKSPACE_SEARCH_INDEX,
            workspace,
          )
          await index.sync(workspace)
          return index.search({ query: 'Quarterly', visibility })
        }),
      )
      found ||= pages.some((page) => !('error' in page) && page.items.length)
      if (
        found &&
        pages.every((page) => !('error' in page) && !page.incomplete)
      )
        break
      if (attempt === 20) throw new Error('Search scenario index is not ready')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
