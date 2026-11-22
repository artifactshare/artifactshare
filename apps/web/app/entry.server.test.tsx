import {
  createRequestHandler,
  Outlet,
  RouterContextProvider,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { Suspense, use, type ReactNode } from 'react'
import { createRequestContext } from './lib/error-diagnostics.server'
import * as serverEntry from './entry.server'

vi.mock('cloudflare:workers', () => ({
  env: { BETTER_AUTH_URL: 'https://app.example' },
}))

test('reports distinct loader and shell failures once per request across render retries', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fault = Object.assign(new Error('synthetic-private-message'), {
    transport: 'synthetic-private-field',
  })
  const loaderFault = new Error(fault.message)
  let rejectStream!: (error: Error) => void
  const streamFailure = new Promise<void>((_resolve, reject) => {
    rejectStream = reject
  })
  let earlyFailure = false
  function StreamContent() {
    if (earlyFailure) throw new TypeError('synthetic-early-message')
    use(streamFailure)
    return <p>Streamed</p>
  }
  let streaming = false
  let broken = false
  let brokenMiddleware = false
  let brokenRootLoader = false
  let brokenLoader = false
  const Layout = vi.fn(({ children }: { children: ReactNode }) => {
    if (broken) throw fault
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    )
  })
  const handler = createRequestHandler(
    {
      entry: { module: serverEntry },
      routes: {
        root: {
          id: 'root',
          path: '/',
          module: {
            Layout,
            default: Outlet,
            loader: () => {
              if (brokenRootLoader) throw new RangeError('root loader failed')
              return null
            },
            ErrorBoundary: () => <p>Unavailable</p>,
          },
        },
        settings: {
          id: 'settings',
          parentId: 'root',
          path: 'settings/:id',
          module: {
            middleware: [
              () => {
                if (brokenMiddleware) throw new TypeError('middleware failed')
              },
            ],
            default: () =>
              streaming ? (
                <Suspense fallback={<p>Loading</p>}>
                  <StreamContent />
                </Suspense>
              ) : (
                <p>Healthy</p>
              ),
            loader: () => {
              if (brokenLoader) throw loaderFault
              return null
            },
          },
        },
      },
      assets: {
        routes: {
          root: {
            id: 'root',
            path: '/',
            module: 'root.js',
            hasAction: false,
            hasLoader: true,
            hasClientAction: false,
            hasClientLoader: false,
            hasClientMiddleware: false,
            hasErrorBoundary: true,
            clientActionModule: undefined,
            clientLoaderModule: undefined,
            clientMiddlewareModule: undefined,
            hydrateFallbackModule: undefined,
          },
          settings: {
            id: 'settings',
            parentId: 'root',
            path: 'settings/:id',
            module: 'settings.js',
            hasAction: false,
            hasLoader: true,
            hasClientAction: false,
            hasClientLoader: false,
            hasClientMiddleware: false,
            hasErrorBoundary: false,
            clientActionModule: undefined,
            clientLoaderModule: undefined,
            clientMiddlewareModule: undefined,
            hydrateFallbackModule: undefined,
          },
        },
        entry: { module: 'entry.js', imports: [] },
        url: 'manifest.js',
        version: 'test',
      },
      publicPath: '/',
      assetsBuildDirectory: 'build/client',
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
    },
    'test',
  )
  const dispatch = () => {
    const request = new Request(
      'https://app.example/settings/synthetic-private-path',
    )
    return handler(request, createRequestContext(request))
  }
  const healthy = await dispatch()
  expect(await healthy.text()).toContain('Healthy')
  expect(log).not.toHaveBeenCalled()
  brokenMiddleware = true
  expect((await dispatch()).status).toBe(500)
  expect(log.mock.calls).toEqual([
    [
      {
        operation: 'router.error',
        cause: 'TypeError',
        frames: expect.any(Array),
        method: 'GET',
        routeId: 'settings',
      },
    ],
  ])
  log.mockClear()
  brokenMiddleware = false
  brokenRootLoader = true
  brokenLoader = true
  const sharedBoundary = await dispatch()
  expect(sharedBoundary.status).toBe(500)
  expect(await sharedBoundary.text()).toContain('Unavailable')
  expect(log.mock.calls).toHaveLength(2)
  expect(log.mock.calls).toContainEqual([
    {
      operation: 'router.error',
      cause: 'RangeError',
      frames: expect.any(Array),
      method: 'GET',
      routeId: 'root',
    },
  ])
  expect(log.mock.calls).toContainEqual([
    {
      operation: 'router.error',
      cause: 'Error',
      frames: expect.any(Array),
      method: 'GET',
      routeId: 'settings',
    },
  ])

  brokenRootLoader = false
  broken = true
  for (const loaderFails of [false, true]) {
    Layout.mockClear()
    log.mockClear()
    brokenLoader = loaderFails
    expect((await dispatch()).status).toBe(500)
    expect(Layout).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([
      ...(loaderFails
        ? [
            [
              {
                operation: 'router.error',
                cause: 'Error',
                frames: expect.any(Array),
                method: 'GET',
                routeId: 'settings',
              },
            ],
          ]
        : []),
      [
        {
          operation: 'router.error',
          cause: 'Error',
          frames: expect.any(Array),
          method: 'GET',
        },
      ],
    ])
  }
  broken = false
  brokenLoader = false
  streaming = true
  log.mockClear()
  earlyFailure = true
  const earlyResponse = await dispatch()
  expect(await earlyResponse.text()).toContain('Loading')
  expect(earlyResponse.status).toBe(500)
  expect(log.mock.calls).toEqual([
    [
      {
        operation: 'router.error',
        cause: 'TypeError',
        frames: expect.any(Array),
        method: 'GET',
      },
    ],
  ])
  earlyFailure = false
  log.mockClear()
  const response = await dispatch()
  const body = response.text()
  rejectStream(new TypeError('synthetic-stream-message'))
  expect(await body).toContain('Loading')
  expect(log.mock.calls).toEqual([
    [
      {
        operation: 'router.error',
        cause: 'TypeError',
        frames: expect.any(Array),
        method: 'GET',
      },
    ],
  ])
  log.mockRestore()
})

test('aborted requests and handled client statuses do not report server faults', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const args = {
    request: new Request('https://app.example'),
    context: new RouterContextProvider(),
    params: {},
  }
  serverEntry.handleError(new Response(null, { status: 403 }), args)
  serverEntry.handleError(new Error('cancelled'), {
    ...args,
    request: new Request(args.request, { signal: AbortSignal.abort() }),
  })
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
})
