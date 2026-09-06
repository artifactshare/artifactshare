import assert from 'node:assert/strict'
import { test } from 'node:test'
import { metricQueries, parseArgs } from './link-open-metrics.mjs'

test('parses the reporting window and target', () => {
  assert.deepEqual(parseArgs([]), { days: 7, remote: true })
  assert.deepEqual(parseArgs(['--', '--days', '30', '--local']), {
    days: 30,
    remote: false,
  })
  assert.throws(() => parseArgs(['--days', '0']))
  assert.throws(() => parseArgs(['--verbose']))
})

test('groups link publishes and anonymous views by plan without identifiers', () => {
  const queries = metricQueries("2026-09-01T00:00:00.000Z'; DROP TABLE x;--")
  assert.match(
    queries.linkPublishes,
    /json_extract\(e\.payload, '\$\.to'\) = 'link'/u,
  )
  assert.match(queries.linkPublishes, /GROUP BY w\.plan/u)
  assert.match(queries.anonymousViews, /actor_user_id IS NULL/u)
  assert.match(queries.anonymousViews, /s\.visibility = 'link'/u)
  assert.ok(queries.linkPublishes.includes("''; DROP TABLE x;--"))
  for (const sql of Object.values(queries)) {
    assert.doesNotMatch(sql, /SELECT[^]*\b(e\.id|s\.id|w\.id)\b[^]*FROM/u)
  }
})
