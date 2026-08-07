import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAnalyticsDimensions } from './check-analytics-dimensions.mjs'

const valid = {
  events: ['a', 'b'],
  params: ['p', 'q'],
  keyEvents: ['a'],
  dimensions: [{ parameterName: 'p', displayName: 'P' }],
  nonDimensionParams: ['q'],
}
test('accepts consistent definitions', () =>
  assert.deepEqual(checkAnalyticsDimensions(valid), []))
test('detects undefined dimension param and unmapped param', () => {
  assert.equal(
    checkAnalyticsDimensions({
      ...valid,
      dimensions: [{ parameterName: 'z', displayName: 'Z' }],
    }).length,
    2,
  )
  assert.ok(
    checkAnalyticsDimensions({ ...valid, nonDimensionParams: [] }).some((x) =>
      x.includes('no dimension mapping'),
    ),
  )
})
test('detects duplicates', () => {
  const failures = checkAnalyticsDimensions({
    events: ['a', 'a'],
    params: ['p', 'p'],
    keyEvents: ['a'],
    dimensions: [
      { parameterName: 'p', displayName: 'P' },
      { parameterName: 'p', displayName: 'P' },
    ],
    nonDimensionParams: [],
  })
  assert.ok(failures.some((x) => x.includes('parameterName')))
  assert.ok(failures.some((x) => x.includes('displayName')))
  assert.ok(failures.some((x) => x.includes('param')))
  assert.ok(failures.some((x) => x.includes('event')))
})
test('detects undefined key event', () =>
  assert.ok(
    checkAnalyticsDimensions({ ...valid, keyEvents: ['z'] }).some((x) =>
      x.includes('undefined event'),
    ),
  ))
