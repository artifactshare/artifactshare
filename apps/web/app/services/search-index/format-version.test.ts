import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { INDEX_FORMAT_VERSION } from './normalize'

// 0130_search_index_change_feed.sql states the rule in a comment: every
// INDEX_FORMAT_VERSION increment must ship a migration in the same change that
// seeds the rebuild for the new format. Until now nothing checked it, and a
// bump without the migration leaves every workspace serving the old index with
// no rebuild queued. This turns that comment into a check.
// fileURLToPath, not URL.pathname: a pathname keeps the percent-encoding, so a
// checkout under a path with a space resolves to a directory that does not
// exist and the check fails for the wrong reason.
const MIGRATIONS = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
)
const SEED =
  /INSERT\s+INTO\s+search_index_rebuilds\s*\(\s*target\s*\)\s*VALUES\s*\(\s*(\d+)\s*\)/gi

function seededTargets(): Map<number, string> {
  const found = new Map<number, string>()
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (!name.endsWith('.sql')) continue
    const sql = readFileSync(`${MIGRATIONS}/${name}`, 'utf8')
    for (const line of sql.split('\n')) {
      // The rule is quoted in a comment above the real statement.
      if (line.trimStart().startsWith('--')) continue
      for (const match of line.matchAll(SEED)) found.set(Number(match[1]), name)
    }
  }
  return found
}

test('a migration seeds the rebuild for the current index format', () => {
  const targets = seededTargets()
  expect(
    targets.size,
    'no migration seeds search_index_rebuilds at all',
  ).toBeGreaterThan(0)
  expect(
    [...targets.keys()].sort((a, b) => a - b).at(-1),
    `the highest search_index_rebuilds target in db/migrations/ must equal INDEX_FORMAT_VERSION (${INDEX_FORMAT_VERSION}). Seeded: ${[
      ...targets,
    ]
      .map(([target, file]) => `${target} (${file})`)
      .join(', ')}`,
  ).toBe(INDEX_FORMAT_VERSION)
})
