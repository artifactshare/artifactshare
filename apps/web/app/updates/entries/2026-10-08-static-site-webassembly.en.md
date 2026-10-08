---
title: Folder shares now run WebAssembly, so SQL runs in the browser
date: 2026-10-08
products: [web, cli, agent]
kind: new
notice: true
---

Folder shares (static sites) can now use WebAssembly and workers. Load an in-browser analytics engine such as DuckDB-WASM from jsDelivr and query Parquet or other data files bundled in the folder with SQL, right in the page. You can share an interactive data dashboard without running a server.

As a sample, we published a dashboard of 150 years of monthly records from 158 Japan Meteorological Agency stations (200,000 rows). Every time you move the year, a SQL query runs in your browser. The live sample and its source code are in [artifactshare/examples](https://github.com/artifactshare/examples).

<!-- more -->

Folders can now include `.wasm` and `.parquet` files, within the existing file count and size limits. Updating only the data publishes a new version at the same URL. If versions keep piling up, you can also set how many versions to keep.

DuckDB-WASM extensions, such as the one that reads Parquet, load from `extensions.duckdb.org`. JavaScript `eval` and `new Function` stay blocked, and network access stays limited to the allowed origins. Single-file HTML and Markdown are unchanged.

Because the data is aggregated in the browser, anyone who can view the dashboard can also download the bundled data files. This does not suit data that must show different rows to different people.

The bundled agent skill explains the loading steps. Pass data URLs as absolute URLs built from the page, such as `new URL('data/rows.parquet', location.href).href`.
