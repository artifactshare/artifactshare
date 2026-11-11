import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

type Specification = { file: string; project: string }
type Durations = Record<string, Record<string, number>>
const durations: Durations = JSON.parse(
  readFileSync(
    new URL('./browser-shard-durations.json', import.meta.url),
    'utf8',
  ),
)

// The discovered specifications own coverage. Historical durations only choose
// their buckets; unknown and renamed files are assigned too.
export function partitionBrowserFiles<T extends Specification>(
  specifications: readonly T[],
  count: number,
  weights: Durations = durations,
) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > specifications.length
  )
    throw new Error('Browser shards require one or more files in every shard')
  const keys = new Set<string>()
  const estimated = specifications.map((specification) => {
    const key = JSON.stringify([specification.project, specification.file])
    if (keys.has(key)) throw new Error('Duplicate browser specification')
    keys.add(key)
    const history = weights[specification.project] ?? {}
    const known = Object.values(history).sort((a, b) => a - b)
    if (known.some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error('Browser durations must be finite positive milliseconds')
    const milliseconds =
      history[specification.file] ?? known[Math.floor(known.length / 2)] ?? 1000
    return { specification, key, milliseconds }
  })
  estimated.sort(
    (a, b) =>
      b.milliseconds - a.milliseconds ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  const shards = Array.from({ length: count }, () => ({
    specifications: [] as T[],
    milliseconds: 0,
  }))
  for (const entry of estimated) {
    const lightest = shards.reduce((best, shard) =>
      shard.milliseconds < best.milliseconds ? shard : best,
    )
    lightest.specifications.push(entry.specification)
    lightest.milliseconds += entry.milliseconds
  }
  return shards
}

export default class BrowserDurationSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (
      !shard ||
      !Number.isSafeInteger(shard.index) ||
      shard.index < 1 ||
      shard.index > shard.count
    )
      throw new Error('Invalid browser shard index')
    const specifications = files.map((specification) => ({
      specification,
      project: specification.project.name,
      file: relative(this.ctx.config.root, specification.moduleId).replaceAll(
        '\\',
        '/',
      ),
    }))
    const selected = partitionBrowserFiles(specifications, shard.count)[
      shard.index - 1
    ]!
    console.info(
      `Browser shard ${shard.index}/${shard.count}: ${selected.specifications.length}/${files.length} discovered files, ${Math.round(selected.milliseconds / 1000)}s historical estimate`,
    )
    return Promise.resolve(
      selected.specifications.map((entry) => entry.specification),
    )
  }
}
