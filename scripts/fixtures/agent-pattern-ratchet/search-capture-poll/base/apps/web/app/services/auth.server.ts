import { workspaceSearchIndex } from './search-index/names'
export async function ensureDevSignInUser(
  env: Env,
  db: Database,
  userId: string,
  workspaceId: string,
  scenario: string | undefined,
  now: number,
) {
  if (scenario?.startsWith('search/')) {
    const index = workspaceSearchIndex(env.WORKSPACE_SEARCH_INDEX, workspaceId)
    await index.sync(workspaceId)
    const ready = await index.search({ query: 'Quarterly' })
    if ('error' in ready || !ready.items.length)
      throw new Error('Search scenario index is not ready')
  }
}
