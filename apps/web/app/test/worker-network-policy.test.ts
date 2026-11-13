import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { http, HttpResponse } from 'msw/http'
import { setupServer } from 'msw/node'
import { expect, onTestFinished, test } from 'vitest'
import {
  integrationUnhandledFrame,
  usercontentUnhandledFrame,
} from './worker-network-policy'

// Real interception proves undeclared traffic cannot escape to the network.
test.each([
  [
    'usercontent',
    usercontentUnhandledFrame,
    'Unexpected Worker network request: https://undeclared.invalid',
  ],
  [
    'integration',
    integrationUnhandledFrame,
    'Unhandled outbound request: GET https://undeclared.invalid/request',
  ],
] as const)(
  '%s enforces its outbound boundary while allowing handled and loopback traffic',
  async (name, policy, diagnostic) => {
    const local = createServer((_request, response) => response.end('loopback'))
    const network = setupServer(
      http.get('https://declared.invalid/request', () =>
        HttpResponse.text('handled'),
      ),
    )
    // Vitest retains the assertion failure even if teardown also fails.
    onTestFinished(async () => {
      network.close()
      await new Promise<void>((resolve, reject) =>
        local.close((error) => (error ? reject(error) : resolve())),
      )
    })
    local.listen(0)
    await once(local, 'listening')
    const address = local.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing TCP address')
    network.listen({ onUnhandledFrame: policy })
    expect(await (await fetch('https://declared.invalid/request')).text()).toBe(
      'handled',
    )
    expect(
      await (await fetch(`http://127.0.0.1:${address.port}/`)).text(),
    ).toBe('loopback')
    if (name === 'usercontent') {
      expect(
        await (await fetch(`http://localhost:${address.port}/`)).text(),
      ).toBe('loopback')
      const ipv6 = new URL(`http://localhost:${address.port}/`)
      ipv6.hostname = '[::1]'
      expect(await (await fetch(ipv6)).text()).toBe('loopback')
    } else {
      const response = await fetch(`http://localhost:${address.port}/`)
      expect(response.status).toBe(500)
      expect(await response.text()).toContain(
        `Unhandled outbound request: GET http://localhost:${address.port}/`,
      )
    }
    const rejected = await fetch('https://undeclared.invalid/request')
    expect(rejected.status).toBe(500)
    expect(await rejected.text()).toContain(diagnostic)
  },
)

// A real Node handshake distinguishes physical delivery from MSW's synthetic open.
test.each([
  ['bypass control', 'bypass', null],
  [
    'usercontent',
    usercontentUnhandledFrame,
    'Unexpected Worker non-HTTP network frame',
  ],
  [
    'integration',
    integrationUnhandledFrame,
    'Unhandled outbound non-HTTP network frame',
  ],
] as const)(
  '%s non-HTTP boundary observes physical WebSocket delivery',
  async (_name, policy, diagnostic) => {
    const local = createServer()
    const sockets = new Set<Duplex>()
    const network = setupServer()
    let client: WebSocket | undefined
    let upgrades = 0
    const listeners = new AbortController()
    onTestFinished(async () => {
      listeners.abort()
      client?.close()
      for (const socket of sockets) socket.destroy()
      network.close()
      await new Promise<void>((resolve, reject) =>
        local.close((error) => (error ? reject(error) : resolve())),
      )
      local.removeAllListeners()
    })
    local.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    local.on('upgrade', (request, socket) => {
      upgrades++
      const accept = createHash('sha1')
        .update(
          `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest('base64')
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'),
      )
      // A text frame received through the native connection proves a valid upgrade.
      const payload = Buffer.from('network-upgrade')
      socket.write(
        Buffer.concat([Buffer.from([0x81, payload.length]), payload]),
      )
    })
    local.listen(0, '127.0.0.1')
    await once(local, 'listening')
    const address = local.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing TCP address')
    network.listen({ onUnhandledFrame: policy })
    const outcome = await new Promise<{ kind: string; detail: unknown }>(
      (resolve) => {
        client = new WebSocket(`ws://127.0.0.1:${address.port}/`)
        client.addEventListener(
          'message',
          (event) => resolve({ kind: 'network-upgrade', detail: event.data }),
          { signal: listeners.signal },
        )
        client.addEventListener(
          'error',
          (event) =>
            resolve({
              kind: 'rejected',
              detail: 'cause' in event ? event.cause : undefined,
            }),
          { signal: listeners.signal },
        )
      },
    )
    expect(
      outcome.kind,
      'undeclared WebSocket must be rejected before physical delivery',
    ).toBe(diagnostic ? 'rejected' : 'network-upgrade')
    expect(upgrades).toBe(diagnostic ? 0 : 1)
    if (diagnostic)
      expect(outcome.detail).toMatchObject({ message: diagnostic })
    else expect(outcome.detail).toBe('network-upgrade')
  },
)
