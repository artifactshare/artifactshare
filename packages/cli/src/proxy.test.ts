import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { test } from 'vitest'
import { expectSuccess, runAsync, withServer } from './test/helpers.js'

/** A forward proxy that sends every request, tunneled or not, to `upstream`
 * and records the host each one asked for. */
async function withProxy<T>(
  upstream: string,
  callback: (proxyUrl: string, seen: string[]) => Promise<T>,
): Promise<T> {
  const target = new URL(upstream)
  const seen: string[] = []
  const proxy = createServer((request, response) => {
    seen.push(new URL(request.url ?? '').host)
    const forwarded = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: request.method,
        path: new URL(request.url ?? '').pathname,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      },
    )
    request.pipe(forwarded)
  })
  proxy.on('connect', (request, socket, head) => {
    seen.push(request.url ?? '')
    const tunnel = connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      tunnel.write(head)
      tunnel.pipe(socket)
      socket.pipe(tunnel)
    })
    tunnel.on('error', () => socket.destroy())
    socket.on('error', () => tunnel.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const { port } = proxy.address() as AddressInfo
  try {
    return await callback(`http://127.0.0.1:${port}`, seen)
  } finally {
    proxy.closeAllConnections()
    await new Promise((resolve) => proxy.close(resolve))
  }
}

function answerWhoami(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  if (request.url !== '/api/cli/whoami') {
    response.statusCode = 404
    response.end()
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      user: { id: 'usr_1', email: 'person@example.com' },
      workspace: { id: 'wrk_1', hosted_domain: null },
    }),
  )
}

test('requests go through the proxy named in HTTPS_PROXY and HTTP_PROXY', async () => {
  await withServer(answerWhoami, (upstream) =>
    withProxy(upstream, async (proxyUrl, seen) => {
      // The host does not resolve, so the request succeeds only through the
      // proxy.
      const result = await runAsync(['whoami', '--json'], {
        ARTIFACTSHARE_TOKEN: 'test-token',
        ARTIFACTSHARE_BASE_URL: 'http://artifactshare.invalid',
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      })
      expectSuccess(result, 'whoami')
      assert.ok(seen.length > 0, 'the proxy received the request')
      for (const host of seen) assert.match(host, /^artifactshare\.invalid/)
    }),
  )
})

test('hosts listed in NO_PROXY are reached directly', async () => {
  await withServer(answerWhoami, (upstream) =>
    withProxy(upstream, async (proxyUrl, seen) => {
      const result = await runAsync(['whoami', '--json'], {
        ARTIFACTSHARE_TOKEN: 'test-token',
        ARTIFACTSHARE_BASE_URL: upstream,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NO_PROXY: '127.0.0.1',
      })
      expectSuccess(result, 'whoami')
      assert.deepEqual(seen, [])
    }),
  )
})
