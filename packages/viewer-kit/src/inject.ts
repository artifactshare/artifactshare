import { VIOLATION_REPORTER_TAG } from './csp-reporter.js'
import { markAnchorSource } from './anchor-text.js'

export function injectReadyReporter(source: string): string {
  // Instrument the parsed head before authored scripts, preserving its attributes,
  // document mode, and the same HTML5 repair rules as the canonical source index.
  return markAnchorSource(source, VIOLATION_REPORTER_TAG).html
}
