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
