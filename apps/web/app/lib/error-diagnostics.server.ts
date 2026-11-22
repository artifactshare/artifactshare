import { createContext, RouterContextProvider } from 'react-router'

// Route instrumentation receives a read-only request view without an abort signal.
export const routerRequestContext = createContext<Request | null>(null)
export function createRequestContext(request: Request) {
  const context = new RouterContextProvider()
  context.set(routerRequestContext, request)
  return context
}

const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
])
const METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
// D1 and SQLite put a result code such as `D1_ERROR` or `SQLITE_CONSTRAINT`
// in the message. Only codes from this fixed list are logged, so the value
// never carries text from the message itself.
const RESULT_CODES = new Set([
  'D1_ERROR',
  'D1_EXEC_ERROR',
  'D1_TYPE_ERROR',
  'D1_COLUMN_NOTFOUND',
  'D1_DUMP_ERROR',
  'SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_RANGE',
  'SQLITE_AUTH',
])
const RESULT_CODE = /\b(?:SQLITE|D1)_[A-Z_]+\b/g
// A stack frame is `at name (file:line:column)` or `at file:line:column`.
// The frame keeps the function name and the source location without any
// query or fragment.
const STACK_FRAME =
  /^\s*at\s+(?:(\S.*?)\s+\()?([^()\s]+?)(?:[?#][^:()\s]*)?(:\d+:\d+)\)?\s*$/
const MAX_FRAMES = 5

function errorName(error: unknown) {
  if (!(error instanceof Error)) return 'Unknown'
  return ERROR_NAMES.has(error.name) ? error.name : 'Error'
}

// An extended SQLite code such as `SQLITE_CONSTRAINT_UNIQUE` is logged as its
// listed base code.
function resultCode(error: unknown) {
  if (!(error instanceof Error)) return undefined
  for (const token of error.message.match(RESULT_CODE) ?? []) {
    const code = [...RESULT_CODES].find(
      (listed) => token === listed || token.startsWith(`${listed}_`),
    )
    if (code) return code
  }
  return undefined
}

// The stack starts with `name: message` (the name the error had when it was
// created), and the message can span lines that look like frames. Frames are
// read only after the message, and only when the stack starts that way, so no
// message text is taken for a frame.
function stackFrames(error: Error) {
  const stack = error.stack ?? ''
  const marker = error.message ? `: ${error.message}` : ''
  const at = marker ? stack.indexOf(marker) : stack.indexOf('\n')
  if (at < 0 || stack.slice(0, at).includes('\n')) return []
  const rest = stack.slice(at + marker.length)
  const frames: string[] = []
  for (const line of rest.split('\n')) {
    const match = line.match(STACK_FRAME)
    if (!match) continue
    const [, name, location, position] = match
    if (/^[a-z][a-z0-9+.-]*:\/\/(?!\/)/i.test(location)) continue
    frames.push(
      name ? `${name} (${location}${position})` : `${location}${position}`,
    )
    if (frames.length === MAX_FRAMES) break
  }
  return frames
}

// Exception messages, custom fields and request URLs can all contain request
// data, so a diagnostic carries only fixed vocabularies: the error name, a
// D1/SQLite result code, the source frames, the method and the static route id.
export function logErrorDiagnostic(
  operation: string,
  error: unknown,
  method?: string,
  routeId?: string,
) {
  const inner = error instanceof Error ? error.cause : undefined
  const code = resultCode(error) ?? resultCode(inner)
  const frames = error instanceof Error ? stackFrames(error) : []
  console.error({
    operation,
    cause: errorName(error),
    ...(inner instanceof Error && { innerCause: errorName(inner) }),
    ...(code && { code }),
    ...(frames.length > 0 && { frames }),
    ...(method && { method: METHODS.includes(method) ? method : 'OTHER' }),
    ...(routeId && { routeId }),
  })
}
