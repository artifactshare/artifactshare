import type { ReporterState } from './state.js'
import { VIOLATION_REPORTER_MARKER } from '../reporter-constants.js'
import { send } from './messaging.js'

export function installCspViolations(ctx: ReporterState) {
  ctx.doc.addEventListener(VIOLATION_REPORTER_MARKER, function (event) {
    send(ctx, {
      kind: 'csp-violation',
      directive: event.violatedDirective || event.effectiveDirective,
      blockedURI: event.blockedURI || 'inline',
      sourceFile: event.sourceFile || null,
      lineNumber: event.lineNumber || null,
    })
  })
}
