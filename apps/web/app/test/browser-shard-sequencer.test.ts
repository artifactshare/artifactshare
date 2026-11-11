import { expect, test } from 'vitest'
import { partitionBrowserFiles } from './browser-shard-sequencer'

const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((file) => ({
  project: 'chromium',
  file,
}))
const weights = { chromium: { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 } }

test('balances heavy files across runners without depending on discovery order', () => {
  const shards = partitionBrowserFiles(files, 3, weights)
  expect(shards.map((shard) => shard.milliseconds)).toEqual([13, 13, 13])
  expect(partitionBrowserFiles([...files].reverse(), 3, weights)).toEqual(
    shards,
  )
})

test('discovery owns coverage even with new, renamed, removed and cross-project files', () => {
  const changed = [
    ...files.slice(1),
    { project: 'chromium', file: 'renamed-a' },
    { project: 'chromium', file: 'new-file' },
    { project: 'firefox', file: 'a' },
  ]
  for (let count = 1; count <= changed.length; count++) {
    const shards = partitionBrowserFiles(changed, count, weights)
    const assigned = shards.flatMap((shard) => shard.specifications)
    expect(assigned).toHaveLength(changed.length)
    expect(new Set(assigned).size).toBe(changed.length)
    expect(new Set(assigned)).toEqual(new Set(changed))
    expect(shards.every((shard) => shard.specifications.length > 0)).toBe(true)
    expect(assigned).not.toContain(files[0])
  }
})

test('uses project median for unknown files and one second without history', () => {
  expect(
    partitionBrowserFiles(
      [
        { project: 'chromium', file: 'new' },
        { project: 'webkit', file: 'new' },
      ],
      1,
      { chromium: { old: 20, other: 60, stale: 100 } },
    )[0]!.milliseconds,
  ).toBe(1060)
})

test('rejects missing work, duplicate specifications and invalid duration or shard counts', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, files.length + 1])
    expect(() => partitionBrowserFiles(files, count, weights)).toThrow()
  expect(() => partitionBrowserFiles([], 1)).toThrow()
  expect(() => partitionBrowserFiles([files[0]!, files[0]!], 1)).toThrow(
    'Duplicate',
  )
  for (const duration of [0, -1, NaN, Infinity])
    expect(() =>
      partitionBrowserFiles(files, 1, { chromium: { a: duration } }),
    ).toThrow('positive')
})
