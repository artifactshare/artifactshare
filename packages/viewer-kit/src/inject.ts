import { VIOLATION_REPORTER_TAG } from './csp-reporter.js'

export function injectReadyReporter(html: string): string {
  const doctype = html.match(/^(?:\s|<!--[\s\S]*?-->)*<!doctype(?:\s[^>]*)?>/i)
  const insertionPoint = doctype?.[0].length ?? 0
  return `${html.slice(0, insertionPoint)}${VIOLATION_REPORTER_TAG}${html.slice(insertionPoint)}`
}
