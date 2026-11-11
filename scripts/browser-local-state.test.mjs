import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { assertPortAvailable } from './browser-local-state.mjs'

async function listen(t, host, port = 0) {
  const server = createServer((socket) => socket.destroy())
  t.after(() => close(server))
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host, port, ipv6Only: host === '::1' }, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    if (
      host === '::1' &&
      ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)
    ) {
      t.skip(`IPv6 loopback bind is unsupported: ${error.code}`)
      return null
    }
    throw error
  }
  return server
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function listenOnBothLoopbacks(t) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ipv4 = await listen(t, '127.0.0.1')
    const { port } = ipv4.address()
    let ipv6
    try {
      ipv6 = await listen(t, '::1', port)
      if (!ipv6) return null
      return { ipv4, ipv6, port }
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === 4) throw error
    } finally {
      if (!ipv6) await close(ipv4)
    }
  }
}

for (const host of ['127.0.0.1', '::1']) {
  test(`port guard rejects an existing ${host}-only listener`, async (t) => {
    let server
    if (host === '::1') {
      const pair = await listenOnBothLoopbacks(t)
      if (!pair) return
      await close(pair.ipv4)
      server = pair.ipv6
    } else {
      server = await listen(t, host)
    }
    if (!server) return
    const { port } = server.address()
    await assert.rejects(assertPortAvailable(port), (error) => {
      assert.ok(error.message.includes(`port ${port} to be free on ${host}`))
      assert.match(
        error.message,
        /cannot validate or mutate an existing dev server/,
      )
      return true
    })
    assert.equal(server.listening, true)
  })
}

test('port guard accepts a port free on both loopback addresses', async (t) => {
  const pair = await listenOnBothLoopbacks(t)
  if (!pair) return
  const { ipv4, ipv6, port } = pair
  await close(ipv4)
  await close(ipv6)
  await assert.doesNotReject(assertPortAvailable(port))
})

test('port guard propagates unexpected probe errors', async () => {
  await assert.rejects(assertPortAvailable(-1), { code: 'ERR_SOCKET_BAD_PORT' })
})
