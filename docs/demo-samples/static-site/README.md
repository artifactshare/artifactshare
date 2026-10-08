# Static-site scripts and data

Folder shares can run WebAssembly from inline bytes or a same-origin `.wasm`
file, and can start same-origin worker files and `blob:` workers. JavaScript
`eval` and `new Function` remain blocked.

DuckDB-WASM can use jsDelivr bundles (`getJsDelivrBundles()`): a blob worker can
call `importScripts()` for the jsDelivr worker, then fetch and compile its `.wasm`
file from the CDN. Blob workers inherit the page's policy. The script CDNs are
jsDelivr, cdnjs, unpkg, esm.sh, and the Tailwind CDN; this does not grant access to
arbitrary network origins.

For a dashboard, keep HTML and JavaScript alongside `data/*.parquet`. In the
page, build an absolute same-origin URL with
`new URL('data/rows.parquet', location.href).href` and pass it to DuckDB-WASM's
`registerFileURL()` before querying the registered file with SQL. Relative URLs
cannot be resolved inside its blob worker. Binary files support byte ranges (`206` with
`Content-Range`). Replace the data locally and update the folder to publish a new
version at the same share URL. Version origins remain isolated.

Single-file HTML and Markdown keep their existing policies. These capabilities
apply to folder shares.
