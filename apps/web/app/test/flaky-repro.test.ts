import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterEach, expect, test, vi } from 'vitest'
import points from './flaky-repro-points.json'
import type { ReproDelayPoint } from './flaky-repro'

const [held, other] = Object.keys(points) as ReproDelayPoint[]
const directories: string[] = []
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'flaky-repro-'))
  directories.push(directory)
  return directory
}

/**
 * The instruments read their variables once, as one repetition of the runner
 * gives them, so each case loads them again with the variables it is about.
 */
const instruments = async (
  variables: { delays?: string; directory?: string } = {},
) => {
  vi.resetModules()
  if ('delays' in variables)
    process.env.FLAKY_REPRO_DELAYS = variables.delays ?? ''
  else delete process.env.FLAKY_REPRO_DELAYS
  if (variables.directory) process.env.FLAKY_REPRO_DIR = variables.directory
  else delete process.env.FLAKY_REPRO_DIR
  return import('./flaky-repro')
}

const fakePage = (evaluated: unknown = {}) => {
  const installed: { how: string; argument: unknown }[] = []
  const page = {
    addInitScript: (_script: unknown, argument: unknown) => {
      installed.push({ how: 'addInitScript', argument })
      return Promise.resolve()
    },
    evaluate: (_script: unknown, argument: unknown) => {
      installed.push({ how: 'evaluate', argument })
      return Promise.resolve(evaluated)
    },
  }
  return { page: page as unknown as Page, installed }
}

const install = () => {}

afterEach(() => {
  delete process.env.FLAKY_REPRO_DELAYS
  delete process.env.FLAKY_REPRO_DIR
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

test('a run that was asked for no hold does not touch the page', async () => {
  for (const variables of [
    undefined,
    { delays: '' },
    { delays: `${other}=400` },
  ]) {
    const { holdAtReproPoint } = await instruments(variables)
    const { page, installed } = fakePage()
    await holdAtReproPoint(page, held, install)
    await holdAtReproPoint(page, held, install, { onLoad: true })
    expect(installed).toEqual([])
  }
})

test('a configured hold is installed with the delays of this run', async () => {
  const { holdAtReproPoint } = await instruments({
    delays: `${held}=400,${other}=500`,
  })
  const { page, installed } = fakePage()
  await holdAtReproPoint(page, held, install)
  expect(installed).toEqual([
    {
      how: 'evaluate',
      argument: [
        [held, 400],
        [other, 500],
      ],
    },
    { how: 'evaluate', argument: held },
  ])
  const onLoad = fakePage()
  await holdAtReproPoint(onLoad.page, other, install, { onLoad: true })
  expect(onLoad.installed.map((entry) => entry.how)).toEqual([
    'addInitScript',
    'addInitScript',
  ])
  expect(onLoad.installed[1]?.argument).toBe(other)
})

test('a delay that names nothing it can hold is refused, not ignored', async () => {
  for (const delays of [
    'typo=400',
    `${held}=0`,
    `${held}=-1`,
    `${held}=4.5`,
    `${held}=soon`,
    held,
  ]) {
    const { holdAtReproPoint } = await instruments({ delays })
    const { page, installed } = fakePage()
    await expect(holdAtReproPoint(page, held, install)).rejects.toThrow(
      /Unknown repro delay point|whole milliseconds/u,
    )
    expect(installed).toEqual([])
  }
})

test('the holds a repetition recorded are kept beside its report', async () => {
  const directory = temporary()
  const { recordReproHolds } = await instruments({
    delays: `${held}=400`,
    directory,
  })
  const { page } = fakePage({ [held]: 3 })
  await recordReproHolds(page)
  await recordReproHolds(page)
  expect(readFileSync(join(directory, 'holds.jsonl'), 'utf8')).toBe(
    `{"${held}":3}\n{"${held}":3}\n`,
  )
})

test('a run with no hold or no directory records no holds', async () => {
  const directory = temporary()
  const withoutDelays = await instruments({ directory })
  const unheld = fakePage({ [held]: 3 })
  await withoutDelays.recordReproHolds(unheld.page)
  const withoutDirectory = await instruments({ delays: `${held}=400` })
  const uncollected = fakePage({ [held]: 3 })
  await withoutDirectory.recordReproHolds(uncollected.page)
  expect([unheld.installed, uncollected.installed, readdirSync(directory)]) //
    .toEqual([[], [], []])
})

test('what a failed scenario looked like is written for the run collecting it', async () => {
  const directory = temporary()
  const { captureReproState } = await instruments({ directory })
  await captureReproState('screens', async () => ({ checks: ['first'] }))
  const [file, ...rest] = readdirSync(directory)
  expect(rest).toEqual([])
  expect(file).toMatch(/^state-screens-\d+\.json$/u)
  expect(JSON.parse(readFileSync(join(directory, file!), 'utf8'))).toEqual({
    checks: ['first'],
  })
})

test('a collector that fails leaves the scenario its own failure', async () => {
  const directory = temporary()
  const collected = await instruments({ directory })
  await collected.captureReproState('screens', () => {
    throw new Error('the frame is gone')
  })
  const written = readdirSync(directory).map((file) =>
    JSON.parse(readFileSync(join(directory, file), 'utf8')),
  )
  expect(written).toEqual([{ uncollected: 'Error: the frame is gone' }])

  const uncollected = await instruments()
  let asked = false
  await uncollected.captureReproState('screens', async () => {
    asked = true
    return {}
  })
  expect(asked).toBe(false)
})

test('a capture nothing can write leaves the scenario its own failure', async () => {
  const directory = temporary()
  const first = await instruments({ directory })
  await first.captureReproState('screens', async () => ({ checks: [] }))
  // A directory under a file: the capture and the holds cannot be written,
  // and the scenario is in the middle of reporting its own failure.
  const blocked = join(directory, readdirSync(directory)[0]!, 'deeper')
  const { captureReproState, recordReproHolds } = await instruments({
    delays: `${held}=400`,
    directory: blocked,
  })
  await expect(
    captureReproState('screens', async () => ({ checks: [] })),
  ).resolves.toBeUndefined()
  await expect(recordReproHolds(fakePage({}).page)).resolves.toBeUndefined()
})
