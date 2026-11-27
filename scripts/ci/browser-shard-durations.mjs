// Rewrites apps/web/app/test/browser-shard-durations.json from the job logs of
// Public CI browser runs, so the shard sequencer balances runners by current
// file durations. Download a run's logs (Actions → run → Download log archive),
// unzip them, and pass the browser job log files. Logs from several runs give
// each file its median duration.
//
//   node scripts/ci/browser-shard-durations.mjs logs/*browser*.txt
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const output = fileURLToPath(
  new URL(
    '../../apps/web/app/test/browser-shard-durations.json',
    import.meta.url,
  ),
)

// Vitest's file summary line, after colors are removed:
//  ✓  chromium  app/lib/pdf-viewer.behavior.browser.test.tsx (36 tests) 84583ms
const FILE_LINE =
  /[✓×❯]\s+(\w+)\s+(app\/\S+\.behavior\.browser\.test\.tsx) \(\d+ tests?[^)]*\) (\d+)ms\s*$/u

export function parseFileDurations(text) {
  const durations = []
  for (const line of stripVTControlCharacters(text).split('\n')) {
    const match = FILE_LINE.exec(line)
    if (match)
      durations.push({
        project: match[1],
        file: match[2],
        milliseconds: Number(match[3]),
      })
  }
  return durations
}

export function medianDurations(durations) {
  const samples = {}
  for (const { project, file, milliseconds } of durations)
    ((samples[project] ??= {})[file] ??= []).push(milliseconds)
  const result = {}
  for (const project of Object.keys(samples).sort()) {
    result[project] = {}
    for (const file of Object.keys(samples[project]).sort()) {
      const sorted = samples[project][file].sort((a, b) => a - b)
      result[project][file] = Math.max(1, sorted[Math.floor(sorted.length / 2)])
    }
  }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const logs = process.argv.slice(2)
  if (logs.length === 0)
    throw new Error('Pass the browser job log files of one or more CI runs')
  const durations = logs.flatMap((log) =>
    parseFileDurations(readFileSync(log, 'utf8')),
  )
  if (durations.length === 0)
    throw new Error('No browser file durations found in the logs')
  writeFileSync(
    output,
    `${JSON.stringify(medianDurations(durations), null, 2)}\n`,
  )
}
