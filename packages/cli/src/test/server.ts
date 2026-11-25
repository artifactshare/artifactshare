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

/** Listen on a free loopback port; the caller closes the server. */
export async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler)
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
  }
}

export async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { baseUrl, close } = await startServer(handler)
  try {
    return await callback(baseUrl)
  } finally {
    await close()
  }
}
