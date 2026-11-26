import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import points from './flaky-repro-points.json'

/**
 * Opt-in instruments for reproducing a flaky browser test, driven by
 * `scripts/ci/flaky-repro.mjs`. Nothing here changes a run that does not set
 * its variables, and no product code reads them: a hold is installed into the
 * page under test through Playwright, from a browser command.
 */
export type ReproDelayPoint = keyof typeof points

/** Installed in the page under test, by `holdAtReproPoint`. */
export interface ReproHoldWindow {
  __flakyReproHold: (point: string) => Promise<void>
}

interface ReproHoldPage extends Partial<ReproHoldWindow> {
  __flakyReproHolds?: Record<string, number>
}

function parseDelays(source: string | undefined) {
  const delays = new Map<string, number>()
  for (const entry of source?.split(',') ?? []) {
    if (!entry) continue
    const [point, value] = entry.split('=')
    if (!Object.hasOwn(points, point))
      throw new Error(
        `Unknown repro delay point ${point}; known points: ${Object.keys(points).join(', ')}`,
      )
    const ms = Number(value)
    if (!Number.isInteger(ms) || ms <= 0)
      throw new Error(`Repro delay for ${point} must be whole milliseconds`)
    delays.set(point, ms)
  }
  return delays
}

let parsed: Map<string, number> | undefined
const delays = () => (parsed ??= parseDelays(process.env.FLAKY_REPRO_DELAYS))

// Milliseconds this run holds at `point`, or 0 when it does not hold there.
const reproDelay = (point: ReproDelayPoint): number => delays().get(point) ?? 0

// One repetition's directory, where the runner collects what this run saw.
const runDirectory = () => process.env.FLAKY_REPRO_DIR

function installHold(entries: [string, number][]) {
  const page = window as unknown as ReproHoldPage
  const holds = (page.__flakyReproHolds ??= {})
  const configured = new Map(entries)
  page.__flakyReproHold ??= (point) => {
    holds[point] = (holds[point] ?? 0) + 1
    // test-wait: elapsed-time — a hold is an elapsed-time delay by design. It
    // widens one window that a passing run closes too fast to observe.
    return new Promise((done) => setTimeout(done, configured.get(point) ?? 0))
  }
}

/**
 * Hold the page at `point` for this run's delay, by installing `install` into
 * it. `install` runs in the page and calls `__flakyReproHold(point)` where the
 * step should wait. Without a delay for `point` nothing is installed, so the
 * scenario keeps its own timing. `onLoad` installs before the next navigation,
 * for a hold that must be in place from the first document.
 */
export async function holdAtReproPoint(
  page: Page,
  point: ReproDelayPoint,
  install: (point: string) => void,
  { onLoad = false } = {},
): Promise<void> {
  if (!reproDelay(point)) return
  const entries = [...delays()]
  if (onLoad) {
    await page.addInitScript(installHold, entries)
    await page.addInitScript(install, point)
  } else {
    await page.evaluate(installHold, entries)
    await page.evaluate(install, point)
  }
}

/**
 * Record how many times each hold actually ran in `page`, before closing it.
 * The runner reports these counts and refuses a run whose configured hold
 * never ran, because such a run proves nothing about the delay.
 */
export async function recordReproHolds(page: Page): Promise<void> {
  const directory = runDirectory()
  if (!directory || !delays().size) return
  const holds = await page
    .evaluate(
      () => (window as unknown as ReproHoldPage).__flakyReproHolds ?? {},
    )
    .catch((error: unknown) => ({ unreadable: String(error) }))
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, 'holds.jsonl'), `${JSON.stringify(holds)}\n`)
}

/**
 * Write what the page looked like when a scenario failed, for the run the
 * runner is collecting. Keep collectors to element identities and states: the
 * file stays on the machine that ran it, and preview URLs carry a capability.
 */
export async function captureReproState(
  label: string,
  state: () => Promise<unknown>,
): Promise<void> {
  const directory = runDirectory()
  if (!directory) return
  const captured = await state().catch((error: unknown) => ({
    uncollected: String(error),
  }))
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `state-${label}-${Date.now()}.json`),
    `${JSON.stringify(captured, null, 2)}\n`,
  )
}
