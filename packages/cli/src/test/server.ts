import assert from 'node:assert/strict'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

/** Stub-server helpers with no reference to the built CLI, so test files that
 * run in a DOM environment can import them too. */

export async function collectBody(request: IncomingMessage): Promise<string> {
  return (await collectBodyBuffer(request)).toString('utf8')
}

export async function collectBodyBuffer(
  request: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Read one field out of a captured multipart/form-data request body. */
export function formField(body: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = body.match(
    new RegExp(`name="${escaped}"\\r\\n\\r\\n([^\\r]*)\\r\\n`),
  )
  return match?.[1] ?? null
}

export type FormPart = { name: string; filename?: string; value: string }

/** Split a captured multipart/form-data body into its parts, in order. */
export function formParts(body: string): FormPart[] {
  const boundary = body.slice(0, body.indexOf('\r\n'))
  if (!boundary.startsWith('--')) return []
  const parts: FormPart[] = []
  for (const chunk of body.split(boundary).slice(1)) {
    const separator = chunk.indexOf('\r\n\r\n')
    if (separator < 0) continue
    const headers = chunk.slice(0, separator)
    const name = /name="([^"]*)"/.exec(headers)?.[1]
    if (name === undefined) continue
    const filename = /filename="([^"]*)"/.exec(headers)?.[1]
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename }),
      value: chunk.slice(separator + 4).replace(/\r\n$/, ''),
    })
  }
  return parts
}

/** Returns whatever the handler returns; several answer with `response.end`,
 * whose return value is the response. */
export type StubHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => unknown

/**
 * These stubs answer from memory over loopback, in well under a second, so a
 * request that gets nothing at all is a path the handler does not serve.
 * Waiting on it only delays the failure until vitest's own test timeout, and
 * that timeout is then spent by every test in the file.
 */
const REQUEST_BUDGET_MS = 5_000

function describeRequest(request: IncomingMessage) {
  return `${request.method ?? 'GET'} ${request.url ?? ''}`
}

/** Keep the thrown error, which carries the failed assertion and its place,
 * and name the request it was answering. */
function annotate(error: unknown, note: string) {
  if (!(error instanceof Error)) return new Error(`${note}: ${String(error)}`)
  error.message = `${error.message}\n${note}`
  return error
}

/** Answer a request the handler left open, so the caller fails on the answer
 * instead of waiting. Anything already streaming is left alone. */
function answerFailure(
  response: ServerResponse,
  status: number,
  reason: string,
) {
  if (response.headersSent || response.destroyed) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ error: { code: 'stub-server', reason } }))
}

/** Listen on a free loopback port; the caller closes the server. */
export async function startServer(handler: StubHandler): Promise<{
  baseUrl: string
  close: () => Promise<void>
  /** The first request the handler failed or never answered, if any. */
  stubFailure: () => Error | undefined
}> {
  let failure: Error | undefined
  const server = createServer((request, response) => {
    const described = describeRequest(request)
    const budget = setTimeout(() => {
      failure ??= new Error(
        `stub server: no answer for ${described} within ${REQUEST_BUDGET_MS} ms`,
      )
      answerFailure(response, 504, `no answer for ${described}`)
    }, REQUEST_BUDGET_MS)
    budget.unref()
    response.on('close', () => clearTimeout(budget))
    const fail = (error: unknown) => {
      clearTimeout(budget)
      failure ??= annotate(
        error,
        `stub server: handler failed for ${described}`,
      )
      answerFailure(response, 500, `handler failed for ${described}`)
    }
    try {
      void Promise.resolve(handler(request, response)).catch(fail)
    } catch (error) {
      fail(error)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    stubFailure: () => failure,
  }
}

export async function withServer<T>(
  handler: StubHandler,
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { baseUrl, close, stubFailure } = await startServer(handler)
  try {
    const value = await callback(baseUrl)
    const failure = stubFailure()
    if (failure) throw failure
    return value
  } catch (error) {
    // The stub failing is the first thing that went wrong, so report that and
    // keep what the caller did with the substitute answer as its cause.
    const failure = stubFailure()
    if (!failure || failure === error) throw error
    failure.cause ??= error
    throw failure
  } finally {
    await close()
  }
}
