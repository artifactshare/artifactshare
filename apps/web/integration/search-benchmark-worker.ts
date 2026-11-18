import { searchIndexName } from '../app/services/search-index/names'
import { searchPalette } from '../app/services/search-palette.server'
import type { SessionUser } from '../app/lib/user'
import { sql } from 'kysely'
import { createDb } from '../app/services/db.server'
import { search, searchSuggestions } from '../app/services/search.server'

/** Setup is outside timed samples. All search timing stays inside the Worker. */
export async function seedSearchBenchmark(
  env: Cloudflare.Env,
  workspace: string,
  size: number,
) {
  const db = createDb(env.DB)
  const now = '2026-09-15T00:00:00.000Z'
  const actor = `${workspace}-actor`,
    owner = `${workspace}-owner`,
    home = `${workspace}-home`
  await db
    .insertInto('workspaces')
    .values({ id: workspace, name: 'Search benchmark', created_at: now })
    .execute()
  for (const id of [actor, owner])
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@example.com`,
        email_verified: 1,
        name: id,
        workspace_id: workspace,
        created_at: now,
        updated_at: now,
      })
      .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspace,
      user_id: actor,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: home,
      workspace_id: workspace,
      kind: 'inbox',
      name: 'Home',
      owner_user_id: actor,
      created_by_id: actor,
      created_at: now,
      updated_at: now,
    })
    .execute()
  for (let offset = 0; offset < size; offset += 500) {
    const rows = Array.from(
      { length: Math.min(500, size - offset) },
      (_, i) => {
        const index = offset + i
        // Alphabetic keys survive numeric-title grouping.
        const key = (size >= 4 && index === size - 2 ? 0 : index)
          .toString(26)
          .replace(/[0-9a-p]/g, (c) =>
            String.fromCharCode(97 + parseInt(c, 26)),
          )
        return {
          id: `${workspace}-${index}`,
          title: `alpha ${key}`,
          owner: index === size - 1 ? owner : actor,
        }
      },
    )
    await sql`INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      SELECT json_extract(value,'$.id'),${workspace},json_extract(value,'$.owner'),json_extract(value,'$.title'),'html_page','private',${home},${now},${now},${now} FROM json_each(${JSON.stringify(rows)})`.execute(
      db,
    )
  }
  await db.destroy()
}
export async function measureSearchBenchmark(
  env: Cloudflare.Env,
  workspace: string,
  warmup: number,
  samples: number,
) {
  const db = createDb(env.DB)
  const durations: number[] = []
  const suggestionDurations: number[] = [],
    paletteDurations: number[] = []
  const queries = ['payload', 'rareword', 'rareword partner', 'lpha', '']
  const classes: Array<{
    query: string
    durations: number[]
    p95: number
    result: Awaited<ReturnType<typeof search>>
  }> = []
  const actor = `${workspace}-actor`
  const user: SessionUser = {
    id: actor,
    email: `${actor}@example.com`,
    emailVerified: true,
    name: actor,
    workspaceId: workspace,
    image: null,
    hd: null,
    msTenantId: null,
    locale: null,
    kind: 'human',
  }

  let result
  for (const query of queries) {
    const classDurations: number[] = []
    for (let i = 0; i < warmup + samples; i++) {
      const start = performance.now()
      // Latency samples must not overlap; concurrent samples measure queueing instead.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      result = await search(
        db,
        (id) => env.WORKSPACE_SEARCH_INDEX.getByName(searchIndexName(id)),
        `${workspace}-actor`,
        {
          query: query,
          filters: {},
          sort: 'relevance',
          pageSize: 20,
        },
      )
      if (i >= warmup) classDurations.push(performance.now() - start)
    }
    if (!result) throw new Error('Missing benchmark result')
    durations.push(...classDurations)
    const ordered = [...classDurations].sort((a, b) => a - b)
    classes.push({
      query,
      durations: classDurations,
      p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
      result,
    })
  }
  for (let i = 0; i < warmup + samples; i++) {
    const suggestionStart = performance.now()
    // Sequential samples measure latency without queueing behind each other.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await searchSuggestions(
      db,
      (id) => env.WORKSPACE_SEARCH_INDEX.getByName(searchIndexName(id)),
      user,
      { query: 'alpha', filters: {}, sort: 'relevance', pageSize: 6 },
    )
    if (i >= warmup)
      suggestionDurations.push(performance.now() - suggestionStart)
    const paletteStart = performance.now()
    await searchPalette(db, user, 'alpha')
    if (i >= warmup) paletteDurations.push(performance.now() - paletteStart)
  }
  await db.destroy()
  durations.sort((a, b) => a - b)
  return {
    result,
    classes,
    durations,
    queries,
    suggestionDurations,
    paletteDurations,
    p95: durations[Math.ceil(durations.length * 0.95) - 1],
  }
}
