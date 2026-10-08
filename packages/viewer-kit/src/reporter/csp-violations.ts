import type { ReporterState } from './state.js'
import { VIOLATION_REPORTER_MARKER } from '../reporter-constants.js'
import { send } from './messaging.js'

export function installCspViolations(ctx: ReporterState) {
  ctx.doc.addEventListener(VIOLATION_REPORTER_MARKER, function (event) {
    const message: Record<string, unknown> = {
      kind: 'csp-violation',
      directive: event.violatedDirective || event.effectiveDirective,
      blockedURI: event.blockedURI || 'inline',
      sourceFile: event.sourceFile || null,
      lineNumber: event.lineNumber || null,
    }
    if (typeof event.sample === 'string') {
      // Indexing preserves the 80 UTF-16-unit bound without calling authored methods.
      let sample = ''
      for (let index = 0; index < event.sample.length && index < 80; index++)
        sample += event.sample[index]
      message.sample = sample
    }
    if (event.disposition === 'enforce' || event.disposition === 'report')
      message.disposition = event.disposition
    send(ctx, message)
  })
}
