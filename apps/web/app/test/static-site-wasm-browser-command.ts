import { createServer } from 'node:http'
import { once } from 'node:events'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import {
  artifactContentSecurityPolicy,
  contentResponse,
  staticSiteAssetResponse,
  staticSiteServiceWorkerRefusal,
} from '../../workers/lib/artifact-response'

// Serve worker requests over loopback: page.route cannot reliably fulfill
// worker fetch/importScripts across all three browser engines. CDN permission
// is checked against the response's script-src/connect-src in bundle-sandbox.test.
export const staticSiteWasm = defineBrowserCommand(
  async ({ page }, reporter: string) => {
    const context = await page.context().browser()!.newContext()
    const artifact = await context.newPage()
    const serviceWorkerRequests: { header: string; status: number }[] = []
    const wasm = [0, 97, 115, 109, 1, 0, 0, 0]
    const worker = (origin: string) => `
      (async () => {
        const response = await fetch('${origin}/fixture.wasm');
        await WebAssembly.instantiateStreaming(response);
        let evalBlocked = false;
        try { eval('1'); } catch (error) { evalBlocked = error instanceof EvalError; }
        let functionBlocked = false;
        try { new Function('return 1')(); } catch (error) { functionBlocked = error instanceof EvalError; }
        let networkBlocked = false;
        try { await fetch('${blockedOrigin}/worker-fetch'); } catch { networkBlocked = true; }
        postMessage({ wasm: 'worker-wasm', evalBlocked, functionBlocked, networkBlocked });
      })().catch(error => postMessage(String(error)));
    `
    let origin = ''
    let blockedOrigin = ''
    let blockedRequests = 0
    // A second loopback port is a real, reachable origin outside the policy.
    // If CSP regresses, these requests succeed and the negative controls fail.
    const blockedServer = createServer((_request, response) => {
      blockedRequests += 1
      response.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Access-Control-Allow-Origin': '*',
      })
      response.end('')
    })
    let html = ''
    const fixtureServer = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', origin).pathname
      // Use the same response builders as serveBundleFile. Only the allowed
      // ancestor is the loopback harness rather than the deployed app origin.
      const send = async (asset: Response) => {
        response.writeHead(asset.status, Object.fromEntries(asset.headers))
        response.end(Buffer.from(await asset.arrayBuffer()))
      }
      const refusal = staticSiteServiceWorkerRefusal(
        new Request(origin + path, {
          headers: new Headers(
            Object.entries(request.headers).flatMap(([key, value]) =>
              value === undefined
                ? []
                : [[key, Array.isArray(value) ? value.join(', ') : value]],
            ),
          ),
        }),
      )
      if (refusal) {
        serviceWorkerRequests.push({
          header: String(request.headers['service-worker']),
          status: refusal.status,
        })
        await send(refusal)
      } else if (path === '/sw.js') {
        await send(
          staticSiteAssetResponse(
            "self.addEventListener('fetch', () => {});",
            'text/javascript',
            origin,
          ),
        )
      } else if (path === '/evil.svg' || path === '/evil.xml') {
        const script = `
          document.documentElement.setAttribute('data-marker', 'executed');
          (async () => {
            let evalBlocked = false;
            try { eval('1'); } catch (error) { evalBlocked = error instanceof EvalError; }
            let networkBlocked = false;
            try { await fetch('${blockedOrigin}/xml-fetch'); } catch { networkBlocked = true; }
            document.documentElement.setAttribute('data-result', JSON.stringify({ evalBlocked, networkBlocked }));
          })();
        `
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/><script><![CDATA[${script}]]></script></svg>`
        const xml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XML</title></head><body><script><![CDATA[${script}]]></script></body></html>`
        await send(
          staticSiteAssetResponse(
            path.endsWith('.svg') ? svg : xml,
            path.endsWith('.svg') ? 'image/svg+xml' : 'application/xml',
            origin,
          ),
        )
      } else if (path === '/fixture.wasm') {
        await send(
          staticSiteAssetResponse(
            new Response(new Uint8Array(wasm)).body,
            'application/wasm',
            origin,
          ),
        )
      } else if (path === '/worker.js') {
        await send(
          staticSiteAssetResponse(worker(origin), 'text/javascript', origin),
        )
      } else if (path === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end(`<!doctype html><script>
          window.reports = [];
          window.reporterReady = new Promise(resolve => {
            addEventListener('message', event => {
              if (event.origin === location.origin &&
                  event.source === document.querySelector('iframe').contentWindow &&
                  event.data?.kind === 'ready' &&
                  event.data.challenge === 'wasm-reporter-probe') resolve();
            });
          });
          addEventListener('message', event => {
            if (event.source === document.querySelector('iframe').contentWindow &&
                event.data?.kind === 'csp-violation') reports.push(event.data);
          });
        </script><iframe sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads" src="/artifact.html" onload="this.contentWindow.postMessage({ source: 'artifactshare-parent', kind: 'ready-check', challenge: 'wasm-reporter-probe' }, location.origin)"></iframe>`)
      } else if (path === '/artifact.html') {
        await send(
          contentResponse(
            html,
            'text/html',
            artifactContentSecurityPolicy('static_site', origin),
          ),
        )
      } else {
        response.writeHead(404).end()
      }
    })
    try {
      blockedServer.listen(0, '127.0.0.1')
      await once(blockedServer, 'listening')
      const blockedAddress = blockedServer.address()
      if (!blockedAddress || typeof blockedAddress === 'string')
        throw new Error('Missing blocked-origin fixture port')
      blockedOrigin = `http://127.0.0.1:${blockedAddress.port}`
      fixtureServer.listen(0, '127.0.0.1')
      await once(fixtureServer, 'listening')
      const address = fixtureServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port')
      origin = `http://127.0.0.1:${address.port}`
      html = `<!doctype html><body>
      <script>
        window.reports = parent.reports;
      </script>
      <script>${reporter}</script>
      <script>
        (async () => {
          let readyTimeout;
          try {
            await Promise.race([
              parent.reporterReady,
              new Promise((_, reject) => {
                readyTimeout = setTimeout(() => reject(new Error('reporter ready-check unanswered')), 1000);
              }),
            ]);
          } finally {
            clearTimeout(readyTimeout);
          }
          const serviceWorker = { supported: 'serviceWorker' in navigator, rejected: false, registrations: -1, controlled: false };
          if (serviceWorker.supported) {
            try { await navigator.serviceWorker.register('/sw.js'); }
            catch { serviceWorker.rejected = true; }
            serviceWorker.registrations = (await navigator.serviceWorker.getRegistrations()).length;
            serviceWorker.controlled = navigator.serviceWorker.controller !== null;
          }
          const svgImage = await new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
            img.onerror = () => resolve(false);
            img.src = '/evil.svg';
            document.body.appendChild(img);
          });
          const bytes = new Uint8Array(${JSON.stringify(wasm)});
          await WebAssembly.compile(bytes);
          await WebAssembly.instantiate(bytes);
          await WebAssembly.instantiateStreaming(fetch('/fixture.wasm'));
          const runWorker = (url, label) => new Promise((resolve, reject) => {
            const worker = new Worker(url);
            worker.onmessage = event => { worker.terminate(); resolve(event.data); };
            worker.onerror = event => { worker.terminate(); reject(new Error(label + " worker: " + (event.message || "script failed to load"))); };
          });
          const local = await runWorker('/worker.js', 'same-origin');
          const url = URL.createObjectURL(new Blob([
            'importScripts("${origin}/worker.js")'
          ], { type: 'text/javascript' }));
          let blob;
          try { blob = await runWorker(url, 'blob'); } finally { URL.revokeObjectURL(url); }
          // Allow native violation events and reporter postMessages to arrive.
          await new Promise(resolve => setTimeout(resolve, 100));
          const allowedReports = reports.slice();
          const blocked = [];
          // Let these exceptions reach the browser's uncaught-exception path.
          // Observe the error without catching it or synthesizing a CSP event,
          // so reporting exercises only native CSP violations.
          for (const source of ["eval('1')", "new Function('return 1')()"]) {
            let evalBlocked = false;
            const onError = event => { evalBlocked = event.error instanceof EvalError; };
            window.addEventListener('error', onError);
            const script = document.createElement('script');
            script.textContent = source;
            try { document.body.appendChild(script); }
            finally {
              window.removeEventListener('error', onError);
              script.remove();
            }
            blocked.push(evalBlocked);
          }
          try { await fetch('${blockedOrigin}/fixture.wasm'); blocked.push(false); }
          catch { blocked.push(true); }
          const scriptBlocked = await new Promise(resolve => {
            const script = document.createElement('script');
            script.src = '${blockedOrigin}/script.js';
            script.onload = () => resolve(false);
            script.onerror = () => resolve(true);
            document.body.appendChild(script);
          });
          blocked.push(scriptBlocked);
          await new Promise(resolve => setTimeout(resolve, 100));
          document.body.dataset.result = JSON.stringify({ local, blob, allowedReports, blocked, reports, serviceWorker, svgImage });
        })().catch(error => { document.body.dataset.result = JSON.stringify({ error: String(error) }); });
      </script>
    </body>`
      await context.route('**/*', async (route) => {
        if (
          [origin, blockedOrigin].includes(
            new URL(route.request().url()).origin,
          )
        )
          await route.continue()
        else await route.abort()
      })
      await artifact.goto(origin, { timeout: 15000 })
      const content = artifact
        .frames()
        .find((frame) => frame.url().endsWith('/artifact.html'))
      if (!content) throw new Error('Static-site frame did not load')
      await content.waitForFunction(
        () => Boolean(document.body.dataset.result),
        undefined,
        { timeout: 15000 },
      )
      const result = await content.evaluate(() =>
        JSON.parse(document.body.dataset.result!),
      )
      const xmlResults = []
      for (const path of ['/evil.svg', '/evil.xml']) {
        await content.evaluate((target) => {
          location.href = target
        }, path)
        await content.waitForURL(origin + path, { timeout: 15000 })
        await content.waitForFunction(
          () => document.documentElement.hasAttribute('data-result'),
          undefined,
          { timeout: 15000 },
        )
        xmlResults.push(
          await content.evaluate(() => ({
            marker: document.documentElement.getAttribute('data-marker'),
            ...JSON.parse(
              document.documentElement.getAttribute('data-result')!,
            ),
          })),
        )
      }
      return {
        ...result,
        blockedOrigin,
        blockedRequests,
        serviceWorkerRequests,
        xmlResults,
      }
    } finally {
      await context.close()
      for (const server of [fixtureServer, blockedServer]) {
        if (!server.listening) continue
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    staticSiteWasm: (reporter: string) => Promise<{
      error?: string
      serviceWorker: {
        supported: boolean
        rejected: boolean
        registrations: number
        controlled: boolean
      }
      serviceWorkerRequests: { header: string; status: number }[]
      svgImage: boolean
      xmlResults: {
        marker: string
        evalBlocked: boolean
        networkBlocked: boolean
      }[]
      blockedOrigin: string
      blockedRequests: number
      local: {
        wasm: string
        evalBlocked: boolean
        functionBlocked: boolean
        networkBlocked: boolean
      }
      blob: {
        wasm: string
        evalBlocked: boolean
        functionBlocked: boolean
        networkBlocked: boolean
      }
      allowedReports: unknown[]
      blocked: boolean[]
      reports: { kind: string; directive: string; blockedURI: string }[]
    }>
  }
}

// Context routing observes Chromium worker fetches at the real HTTPS origin.
// The existing loopback WASM command above retains all-engine coverage.
export const staticSiteExtensions = defineBrowserCommand(async ({ page }) => {
  const context = await page.context().browser()!.newContext()
  const extensionUrl =
    'https://extensions.duckdb.org/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm'
  let fulfilledRequests = 0
  let blockedRequests = 0
  let origin = ''
  let blockedOrigin = ''
  const worker = () => `
    (async () => {
      const response = await fetch('${extensionUrl}');
      if (!response.ok) throw new Error('Extension HTTP ' + response.status);
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      let networkBlocked = false;
      try { await fetch('${blockedOrigin}/worker-fetch'); } catch { networkBlocked = true; }
      postMessage({ bytes, networkBlocked });
    })().catch(error => postMessage({ error: String(error) }));
  `
  const blockedServer = createServer((_request, response) => {
    blockedRequests += 1
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
    response.end('reachable')
  })
  const fixtureServer = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname
    let asset: Response
    if (path === '/worker.js') {
      asset = staticSiteAssetResponse(worker(), 'text/javascript', origin)
    } else if (path === '/') {
      asset = contentResponse(
        `<!doctype html><body><script>
          (async () => {
            const runWorker = url => new Promise((resolve, reject) => {
              const worker = new Worker(url);
              const finish = (error, result) => {
                clearTimeout(timer);
                worker.terminate();
                if (error) reject(error); else resolve(result);
              };
              const timer = setTimeout(() => finish(new Error('Worker timed out')), 5000);
              worker.onmessage = event => finish(null, event.data);
              worker.onerror = event => finish(new Error(event.message || 'Worker failed'));
            });
            const local = await runWorker('/worker.js');
            const url = URL.createObjectURL(new Blob([${JSON.stringify(worker())}], { type: 'text/javascript' }));
            let blob;
            try { blob = await runWorker(url); } finally { URL.revokeObjectURL(url); }
            document.body.dataset.result = JSON.stringify({ local, blob });
          })().catch(error => { document.body.dataset.result = JSON.stringify({ error: String(error) }); });
        </script></body>`,
        'text/html',
        artifactContentSecurityPolicy('static_site', origin),
      )
    } else {
      response.writeHead(404).end()
      return
    }
    response.writeHead(asset.status, Object.fromEntries(asset.headers))
    response.end(Buffer.from(await asset.arrayBuffer()))
  })
  try {
    for (const server of [blockedServer, fixtureServer]) {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
    }
    const address = fixtureServer.address()
    const blockedAddress = blockedServer.address()
    if (
      !address ||
      typeof address === 'string' ||
      !blockedAddress ||
      typeof blockedAddress === 'string'
    )
      throw new Error('Missing extension fixture port')
    origin = `http://127.0.0.1:${address.port}`
    blockedOrigin = `http://127.0.0.1:${blockedAddress.port}`
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url === extensionUrl) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/wasm',
            'Access-Control-Allow-Origin': '*',
          },
          body: Buffer.from([68, 85, 67, 75]),
        })
        fulfilledRequests += 1
      } else if ([origin, blockedOrigin].includes(new URL(url).origin)) {
        // The negative control must reach its server if CSP permits it.
        await route.continue()
      } else {
        await route.abort()
      }
    })
    const artifact = await context.newPage()
    await artifact.goto(origin, { timeout: 15000 })
    await artifact.waitForFunction(
      () => Boolean(document.body.dataset.result),
      undefined,
      { timeout: 15000 },
    )
    const result: {
      error?: string
      local: ExtensionWorkerResult
      blob: ExtensionWorkerResult
    } = await artifact.evaluate(() => JSON.parse(document.body.dataset.result!))
    return { ...result, fulfilledRequests, blockedRequests }
  } finally {
    // Closing the dedicated context removes routing, pages and workers even on failure.
    try {
      await context.close()
    } finally {
      for (const server of [fixtureServer, blockedServer]) {
        if (!server.listening) continue
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  }
})

type ExtensionWorkerResult = {
  error?: string
  bytes: number[]
  networkBlocked: boolean
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    staticSiteExtensions: () => Promise<{
      error?: string
      local: ExtensionWorkerResult
      blob: ExtensionWorkerResult
      fulfilledRequests: number
      blockedRequests: number
    }>
  }
}

// Isolate XML frame-ancestors from the parent's separate object-src restriction.
// The host is intentionally unpoliced: production static-site HTML still denies
// objects via default-src 'none'. The SVG uses the complete production policy.
export const staticSiteXmlEmbedding = defineBrowserCommand(async ({ page }) => {
  const context = await page.context().browser()!.newContext()
  let assetOrigin = ''
  let viewerOrigin = ''
  let blockedRequests = 0
  let controlRequests = 0
  const viewerServer = createServer((request, response) => {
    if (request.url === '/blocked' || request.url === '/control') {
      if (request.url === '/blocked') blockedRequests += 1
      else controlRequests += 1
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
      response.end('reachable')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      `<!doctype html><iframe src="${assetOrigin}/host.html"></iframe>`,
    )
  })
  const assetServer = createServer(async (request, response) => {
    let asset: Response
    if (request.url === '/chart.svg') {
      asset = staticSiteAssetResponse(
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16">
          <rect width="24" height="16" fill="red"/>
          <script><![CDATA[
            document.documentElement.setAttribute('data-marker', 'executed');
            (async () => {
              let evalBlocked = false;
              try { eval('1'); } catch (error) { evalBlocked = error instanceof EvalError; }
              let networkBlocked = false;
              try { await fetch('${viewerOrigin}/blocked'); } catch { networkBlocked = true; }
              document.documentElement.setAttribute('data-result', JSON.stringify({ evalBlocked, networkBlocked }));
            })();
          ]]></script>
        </svg>`,
        'image/svg+xml',
        viewerOrigin,
      )
    } else if (request.url === '/host.html') {
      asset = contentResponse(
        `<!doctype html><body><script>
          (async () => {
            // Prove the unlisted origin is reachable before the SVG probes it.
            const control = await fetch('${viewerOrigin}/control');
            if (await control.text() !== 'reachable') throw new Error('Control failed');
            const object = document.createElement('object');
            object.type = 'image/svg+xml';
            object.data = '/chart.svg';
            object.width = '24';
            object.height = '16';
            document.body.appendChild(object);
          })();
        </script></body>`,
        'text/html',
        null,
      )
    } else {
      response.writeHead(404).end()
      return
    }
    response.writeHead(asset.status, Object.fromEntries(asset.headers))
    response.end(Buffer.from(await asset.arrayBuffer()))
  })
  try {
    for (const server of [viewerServer, assetServer]) {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
    }
    const viewerAddress = viewerServer.address()
    const assetAddress = assetServer.address()
    if (
      !viewerAddress ||
      typeof viewerAddress === 'string' ||
      !assetAddress ||
      typeof assetAddress === 'string'
    )
      throw new Error('Missing XML embedding fixture ports')
    viewerOrigin = `http://127.0.0.1:${viewerAddress.port}`
    assetOrigin = `http://127.0.0.1:${assetAddress.port}`
    await context.route('**/*', async (route) => {
      if (
        [viewerOrigin, assetOrigin].includes(
          new URL(route.request().url()).origin,
        )
      )
        await route.continue()
      else await route.abort()
    })
    const viewer = await context.newPage()
    await viewer.goto(viewerOrigin, { timeout: 15000 })
    const host = viewer
      .frames()
      .find((frame) => frame.url() === `${assetOrigin}/host.html`)
    if (!host) throw new Error('XML object host did not load')
    await host.waitForFunction(
      () => {
        const doc = document.querySelector('object')?.contentDocument
        return doc?.documentElement.hasAttribute('data-result')
      },
      undefined,
      { timeout: 15000 },
    )
    const result = await host.evaluate(() => {
      const doc = document.querySelector('object')!.contentDocument!
      const rect = doc.querySelector('rect')!.getBoundingClientRect()
      return {
        marker: doc.documentElement.getAttribute('data-marker'),
        rendered: rect.width > 0 && rect.height > 0,
        ...JSON.parse(doc.documentElement.getAttribute('data-result')!),
      }
    })
    return { ...result, blockedRequests, controlRequests }
  } finally {
    try {
      await context.close()
    } finally {
      for (const server of [viewerServer, assetServer]) {
        if (!server.listening) continue
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  }
})

declare module 'vitest/browser' {
  interface BrowserCommands {
    staticSiteXmlEmbedding: () => Promise<{
      marker: string
      rendered: boolean
      evalBlocked: boolean
      networkBlocked: boolean
      blockedRequests: number
      controlRequests: number
    }>
  }
}
