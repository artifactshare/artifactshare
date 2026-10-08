# WebAssembly in static sites

Static-site dashboards may compile and instantiate WebAssembly, create
same-origin and blob workers, and load DuckDB-WASM from the existing script CDNs.
Single-file HTML and Markdown retain their current policies.

The static-site `script-src` includes `wasm-unsafe-eval` and the existing script
CDN origins. Blob workers inherit this policy. The existing CDN origins appear
in both `script-src` and `script-src-elem`, so worker `importScripts()` calls are
allowed whichever directive an engine applies. `script-src-elem` also lists the
social embed script hosts; no new origin is added. `worker-src 'self' blob:`
allows ordinary dedicated and blob worker creation; service-worker script fetches are refused. JavaScript `eval` and `new Function` remain blocked in
documents served with the static-site CSP and their blob workers. JavaScript
files served from a static site carry that CSP, so a worker started from a
same-origin script file keeps the eval and network limits. MIME matching ignores
case and charset parameters and covers JavaScript MIME variants. Asset bytes
and range handling are unchanged. XML document responses (application/xml,
text/xml, and all +xml types, including SVG and XHTML) also carry the policy.
Only XML responses add `'self'` to `frame-ancestors`, retaining the supplied
viewer, link-viewer, and embed origins. This permits a same-origin intermediate
ancestor when the parent permits embedding. It does not relax the parent's
`object-src` or `frame-src`: static-site HTML still blocks objects through
`default-src 'none'` and does not permit same-origin child frames.
Other binary responses, including PNG and WASM, receive no CSP.

Static-site asset requests with a `Service-Worker: script` header (ignoring
case and surrounding whitespace) receive an empty 403 before body or range
processing. This prevents new registrations and update fetches from installing
scripts that could synthesize policy-free responses. It does not remove existing
registrations or retroactively control cached synthetic responses. XML documents
retain their bytes and content types and now enforce the static-site policy when
navigated to. SVG still renders as an image; image embedding does not apply the
response CSP. Authorization and single-document HTML/Markdown are unchanged.

`https://extensions.duckdb.org` is the sole added `connect-src` origin, appended
after the existing sources. Image, frame, and media origins remain unchanged.
Only XML response frame ancestors change. Iframe sandbox permissions,
version-scoped origins, and access checks stay unchanged.
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

A separate Chromium test intercepts the exact HTTPS extension URL with
BrowserContext routing and supplies synthetic bytes without public network
access. Both worker forms must receive those bytes and reject a reachable,
CORS-compatible unlisted loopback endpoint with zero requests reaching it.
Unexpected external requests are aborted; loopback requests pass through.
This exact-origin probe is skipped in Firefox and WebKit; the loopback WASM
coverage above continues to run in all three engines.

DuckDB-WASM loads runtime extensions such as `parquet` and `json` from
`https://extensions.duckdb.org/<duckdb-version>/<wasm_eh|wasm_mvp>/<name>.duckdb_extension.wasm`.
Static-site `connect-src` permits that origin: blob workers inherit the page's
policy, and same-origin JavaScript workers carry it. This permission covers
extension fetching, not arbitrary network origins.

To avoid the external extension request, bundle every needed extension matching
the DuckDB engine version and selected WASM platform. Preserve the repository's
version/platform layout, for example
`extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` for `@duckdb/duckdb-wasm@1.32.0`.
The folder must match the engine version the page loads, which `SELECT version()`
reports, so pin the package version. In the page, compute
`new URL('extensions', location.href).href` (no trailing slash; DuckDB appends `/<version>/...`) and use that absolute same-origin
repository URL in `SET custom_extension_repository = '<absolute same-origin repository URL>'`
before any extension loads or queries. This avoids requests to the extension
host; jsDelivr core bundles still require CDN requests.

The eval and Function probes run as separate inline scripts with uncaught
EvalErrors observed by an error listener in every engine. Chromium and Firefox
must deliver a native `script-src` eval violation through the injected reporter.
WebKit blocks eval but dispatches no CSP violation event for it, so the reporter
does not report it there. This is existing behavior, unchanged by this work.
Allowed WebAssembly and worker operations must produce no reports in any engine.

The reporter is unchanged and retains its document-only native CSP listener.
Errors and unhandled rejections are not interpreted as CSP violations.

Folder uploads accept `.wasm` as `application/wasm` and `.parquet` as
`application/octet-stream`, based on the extension rather than client MIME.
Uppercase extensions are accepted. Single-file types, entrypoint detection,
path validation, quotas, file counts and size limits remain unchanged.
Create and version-update tests verify exact stored bytes and canonical MIME;
route and dialog tests cover the folder upload path. WASM responses retain
`application/wasm` for `instantiateStreaming`.

The browser loopback fixture serves assets with the production response builder
used by `serveBundleFile`, including JavaScript CSP and WASM content type. It
supplies only the harness origin as the frame ancestor. Both worker forms must
reject eval, Function construction, and fetches to the blocked loopback origin.
Multipart API tests call the real upload session's `addFile` method and verify
stored bytes and MIME metadata; only publication is stubbed in those route tests.

Deterministic regression probes exercise service-worker refusal and XML document
eval/network blocking over loopback, with a reachable CORS-enabled negative
control and SVG image rendering. Handler tests cover all bundle access paths,
normalized headers, and byte ranges without reading rejected script bodies.

An additional loopback object probe isolates XML `frame-ancestors` using an
unrestricted host page beneath a different viewer origin. The embedded SVG must
render and execute a benign marker while eval and unlisted-origin fetches remain
blocked. This probe does not assert that static-site HTML permits objects.
