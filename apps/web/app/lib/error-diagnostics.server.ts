import { createContext, RouterContextProvider } from 'react-router'

// Route instrumentation receives a read-only request view without an abort signal.
export const routerRequestContext = createContext<Request>()
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
// D1 and SQLite put a fixed result code in the message, such as
// `D1_ERROR` or `SQLITE_CONSTRAINT`. The code is safe to log; the rest of the
// message can quote values from the request.
const RESULT_CODE = /\b(?:SQLITE|D1)_[A-Z_]+\b/
// A stack line is `at name (location)` or `at location`. The frame keeps the
// function name and the source location without any query or fragment.
const STACK_FRAME =
  /^\s*at\s+(?:(.+?)\s+\()?([^()\s]+?)(?:[?#][^:()\s]*)?(:\d+:\d+)?\)?\s*$/
const MAX_FRAMES = 5

function errorName(error: unknown) {
  if (!(error instanceof Error)) return 'Unknown'
  return ERROR_NAMES.has(error.name) ? error.name : 'Error'
}

function resultCode(error: unknown) {
  return error instanceof Error
    ? error.message.match(RESULT_CODE)?.[0]
    : undefined
}

function stackFrames(error: Error) {
  const frames: string[] = []
  for (const line of (error.stack ?? '').split('\n')) {
    const match = line.match(STACK_FRAME)
    if (!match) continue
    const [, name, location, position = ''] = match
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
