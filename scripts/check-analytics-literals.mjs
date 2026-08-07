// GA4 送信は events.ts / track.client.ts 経由に限定する。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
const root = new URL('..', import.meta.url).pathname
const allowed = new Set([
  'apps/web/app/lib/analytics/track.client.ts',
  'apps/web/app/root.tsx',
])
const deny = /gtag\((['"])event\1|dataLayer\.push/g
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })
}
export function findAnalyticsLiteralViolations(scanRoot = root) {
  return filesUnder(join(scanRoot, 'apps/web/app')).flatMap((file) => {
    const relativePath = relative(scanRoot, file)
    if (allowed.has(relativePath)) return []
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) =>
        [...line.matchAll(deny)].map((match) => ({
          file: relativePath,
          line: index + 1,
          text: match[0],
        })),
      )
  })
}
if (import.meta.main) {
  const violations = findAnalyticsLiteralViolations(process.argv[2] ?? root)
  for (const violation of violations)
    console.error(`${violation.file}:${violation.line}: ${violation.text}`)
  if (violations.length) process.exitCode = 1
}
