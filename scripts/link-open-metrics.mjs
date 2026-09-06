#!/usr/bin/env node
// Reports how link sharing is used after it opened to Free workspaces:
// link publishes recorded as visibility_changed events and anonymous views of
// link-visible artifacts, both grouped by workspace plan. Read-only; runs the
// queries through wrangler against the local dev D1 by default, or against
// production with --remote. Prints no workspace or artifact identifiers, only
// counts.
//
//   pnpm link-open:metrics -- --days 7            (local dev D1)
//   pnpm link-open:metrics -- --days 30 --remote  (production D1, operators only)

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function parseArgs(argv) {
  const options = { days: 7, remote: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--remote') options.remote = true
    else if (arg === '--local') options.remote = false
    else if (arg === '--days') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10)
      if (!Number.isInteger(value) || value < 1 || value > 365)
        throw new Error('--days must be an integer between 1 and 365')
      options.days = value
      index += 1
    } else throw new Error(`unknown argument ${arg}`)
  }
  return options
}

export function metricQueries(sinceIso) {
  const since = sinceIso.replace(/'/gu, "''")
  return {
    linkPublishes: `SELECT w.plan AS plan,
  COUNT(*) AS publishes,
  COUNT(DISTINCT e.workspace_id) AS workspaces,
  COUNT(DISTINCT e.shareable_id) AS artifacts
FROM events e JOIN workspaces w ON w.id = e.workspace_id
WHERE e.type = 'visibility_changed'
  AND json_extract(e.payload, '$.to') = 'link'
  AND e.created_at >= '${since}'
GROUP BY w.plan ORDER BY w.plan`,
    anonymousViews: `SELECT w.plan AS plan,
  COUNT(*) AS anonymous_views,
  COUNT(DISTINCT e.shareable_id) AS artifacts
FROM events e
JOIN shareables s ON s.id = e.shareable_id
JOIN workspaces w ON w.id = s.workspace_id
WHERE e.type = 'artifact_viewed'
  AND e.actor_user_id IS NULL
  AND s.visibility = 'link'
  AND e.created_at >= '${since}'
GROUP BY w.plan ORDER BY w.plan`,
    linkVisibleNow: `SELECT w.plan AS plan, COUNT(*) AS link_visible_artifacts
FROM shareables s JOIN workspaces w ON w.id = s.workspace_id
WHERE s.visibility = 'link'
GROUP BY w.plan ORDER BY w.plan`,
  }
}

function runQuery(sql, remote) {
  // Run inside apps/web like `pnpm dev` so local mode reads the same D1 state.
  const webDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'apps',
    'web',
  )
  const configPath = remote ? 'wrangler.production.jsonc' : 'wrangler.jsonc'
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '-c',
      configPath,
      remote ? '--remote' : '--local',
      '--json',
      '--command',
      sql,
    ],
    { cwd: webDir, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'wrangler failed')
  }
  const parsed = JSON.parse(result.stdout)
  return parsed[0]?.results ?? []
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const since = new Date(Date.now() - options.days * 86_400_000).toISOString()
  const queries = metricQueries(since)
  console.log(
    `link sharing metrics since ${since} (${options.remote ? 'remote' : 'local'} D1)`,
  )
  for (const [name, sql] of Object.entries(queries)) {
    console.log(`\n${name}`)
    console.table(runQuery(sql, options.remote))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
