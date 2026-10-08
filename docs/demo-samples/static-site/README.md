# Static-site scripts and data

Folder shares can run WebAssembly from inline bytes or a same-origin `.wasm`
file, and can start same-origin worker files and `blob:` workers. JavaScript
`eval` and `new Function` remain blocked.

DuckDB-WASM can use jsDelivr bundles (`getJsDelivrBundles()`): a blob worker can
call `importScripts()` for the jsDelivr worker, then fetch and compile its `.wasm`
file from the CDN. Blob workers inherit the page's policy. The script CDNs are
jsDelivr, cdnjs, unpkg, esm.sh, and the Tailwind CDN; this does not grant access to
arbitrary network origins.

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

For a dashboard, keep HTML and JavaScript alongside `data/*.parquet`. In the
page, build an absolute same-origin URL with
`new URL('data/rows.parquet', location.href).href` and pass it to DuckDB-WASM's
`registerFileURL()` before querying the registered file with SQL. Relative URLs
cannot be resolved inside its blob worker. Binary files support byte ranges (`206` with
`Content-Range`). Replace the data locally and update the folder to publish a new
version at the same share URL. Version origins remain isolated.

Single-file HTML and Markdown keep their existing policies. These capabilities
apply to folder shares.
