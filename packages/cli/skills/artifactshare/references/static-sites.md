## Static-site scripts and data

Folder shares load external HTTPS images, stylesheets from jsDelivr, cdnjs,
unpkg, and Google Fonts (`fonts.googleapis.com`), and font files from jsDelivr
and Google Fonts (`fonts.gstatic.com`). Load icon/font packages from jsDelivr
or bundle the font files because cdnjs and unpkg font files are blocked.
JavaScript `eval` and `new Function` remain blocked.

Folder shares support WebAssembly, same-origin worker files, and `blob:` workers.
DuckDB-WASM can load from jsDelivr: its `getJsDelivrBundles()` setup uses a blob
worker to `importScripts()` the CDN worker and fetch its `.wasm` file. The existing
script CDNs are allowed inside blob workers; JavaScript `eval` and `new Function`
remain blocked in the page and its blob workers.

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

Keep data such as `data/*.parquet` in the shared folder. In the page, build an
absolute same-origin URL with `new URL('data/rows.parquet', location.href).href`
and pass it to DuckDB-WASM's `registerFileURL()` before querying the registered
file with SQL. Relative URLs cannot be resolved inside its blob worker.
Static-site binary assets support HTTP byte ranges. To refresh data while keeping
the same share URL, replace the data locally and update the folder as a new
version; each version retains its own isolated origin. Single-file HTML and
Markdown have different script policies; these permissions apply to folder shares.
