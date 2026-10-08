# WebAssembly in static sites

Static-site dashboards may compile and instantiate WebAssembly, create
same-origin and blob workers, and load DuckDB-WASM from the existing script CDNs.
Single-file HTML and Markdown retain their current policies.

The static-site `script-src` includes `wasm-unsafe-eval` and the existing script
CDN origins. Blob workers inherit this policy, and their `importScripts()` uses
`script-src`, not the document's `script-src-elem`. `worker-src 'self' blob:`
allows worker creation. JavaScript `eval` and `new Function` remain blocked in
the document and inherited blob-worker policy. Same-origin worker responses
retain their existing asset headers.

No connect, image, frame, or media origins change. Frame ancestors, iframe
sandbox permissions, version-scoped origins, and access checks stay unchanged.
The reporter continues to forward native CSP violations: permitted operations
produce no notices, and blocked eval remains reportable.

Binary bundle assets already support byte ranges, returning `206`,
`Content-Range`, and the requested bytes. No range implementation change is
needed for folder Parquet data. Updating data publishes a new isolated version;
it does not mutate files within an existing version.

Regression coverage checks the CDN permissions in the response's `script-src`
and `connect-src`, including jsDelivr for worker imports and WASM downloads.
Browser tests serve a minimal WASM module and worker script over loopback HTTP,
then exercise same-origin and blob workers, `importScripts()`, and WASM fetches
under CSP. Worker requests do not rely on Playwright page-route interception,
which is not reliable across all browser engines. Negative controls cover eval,
Function construction, and unlisted script and connection origins without public
internet access.

The eval and Function probes run as separate inline scripts with uncaught
EvalErrors observed by an error listener in every engine. Chromium and Firefox
must deliver a native `script-src` eval violation through the injected reporter.
WebKit blocks eval but dispatches no CSP violation event for it, so the reporter
does not report it there. This is existing behavior, unchanged by this work.
Allowed WebAssembly and worker operations must produce no reports in any engine.

The reporter retains the document-only native CSP listener from main. The
window listener and message-based EvalError fallback are removed; no reproduced
Chromium or Firefox failure establishes a need for the extra listener. Errors
and unhandled rejections are not interpreted as CSP violations.
