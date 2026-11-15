# Local development harness

This is the current contract for running the application, its local bindings, and browser-level development checks without Cloudflare credentials.

## Start the complete topology

```sh
pnpm dev
```

The command prepares local inputs and then starts three HTTPS services:

| Service | Origin |
| --- | --- |
| Application | `https://localhost:5173` |
| Artifact sandbox | `https://*.usercontent.localhost:5174` |
| Open Graph image worker | `https://localhost:5175` |

If one or more of these services already responds on its expected origin, the
launcher reuses it and starts only the missing siblings. Stopping that launcher
terminates only the processes it started, so starting a missing sandbox does not
replace or stop an existing application process.

Local bindings are forced local with `remoteBindings: false`. Development must not depend on a Cloudflare login or production resources.

Before starting a worker, the launcher runs the same preparation as `pnpm dev:setup`:

- create the local certificate pair when absent;
- create `.dev.vars` from the example and generate a development authentication secret when absent;
- apply `apps/web/db/schema.sql` to an empty local D1 database;
- reject an existing database whose objects differ from the current schema.

After those steps, `pnpm dev:setup` also builds the git-ignored static-site fixtures under `fixtures/static-sites/` when any is missing (about a minute the first time); a failed build is reported without stopping the servers, and `--no-fixtures` (or `CI`) skips it. Preparation is non-destructive by default. If the database differs, inspect the reported difference and run `pnpm dev:setup --reset` explicitly. An isolated state directory can be selected with `--persist-to <directory>`.

The app and sandbox configurations intentionally point at the same local D1 persistence directory. Schema discovery must run separately for each target because applying the app schema changes what the sandbox target observes.

## Browser navigation check

```sh
pnpm check:in-app-navigation
```

The check starts the application when necessary, signs in through the development persona API, waits for hydration, and clicks between the main file and recent-activity views. It fails on document navigation, console errors, or page errors. Set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome; otherwise install the web workspace's Chromium build.

## Setup recovery check

```sh
pnpm check:dev-setup
```

This uses a temporary persistence directory. It proves setup on an empty database and repeated reset of a populated database, including foreign-key-safe drop ordering. It never writes to the ordinary development state. The navigation check also starts its fallback server with an isolated state through the Vite plugin's `persistState.path`; preparation and runtime therefore see the same D1 database.

## Built preview

`pnpm --filter @artifactshare/web preview --host 127.0.0.1 --port 4173` is a separate, HTTP-only preview of a completed build. It does not start the sandbox or image worker and is not the canonical full-development command. When testing authentication in preview, set `BETTER_AUTH_URL=http://127.0.0.1:4173` for that invocation.

## Generated files

`.dev.vars`, `.dev-certs/`, and `.wrangler/` are local inputs or state and must remain untracked. Never place production credentials in them for this harness.


Artifact execution uses `a-<id>--v-<hex-version>.usercontent.localhost:5174`
for authenticated viewing and `l-<id>--v-<hex-version>.usercontent.localhost:5174`
for anonymous link viewing. The app stays at `localhost:5173` and link viewers
stay at `<id>.localhost:5173`. Regenerate the local certificate with `dev:setup`
when moving from the old sandbox wildcard. These hosts are all same-site;
passing this harness does not prove third-party-cookie blocking compatibility.
Cross-site browser evidence must use distinct sites mapped to loopback, block
external traffic, and record exact browser versions and cookie settings.

Run the self-contained cross-site regression with:

```sh
pnpm --filter @artifactshare/web exec vitest --config vitest.behavior.browser.config.ts run app/lib/usercontent-delivery.behavior.browser.test.tsx
```

The command builds the app locally and starts isolated Worker, D1, R2, HTTPS,
and proxy instances. Reserved `app.example`, `<id>.link.example`, and
`<kind>-<id>--v-<hex-version>.usercontent.example` hosts map one-to-one to the
Worker origins. The proxy translates URL/Origin and CSP/CORS hostnames together;
signed tokens and cookies remain untouched. No real DNS or account is used.
Unexpected browser and Worker traffic is blocked. A temporary self-signed test
certificate is accepted only by the test browser context. All servers, contexts,
and temporary keys are cleaned up by the command.

Chromium uses `Network.setCookieControls` with third-party restriction enabled.
Firefox runs default Total Cookie Protection (`network.cookie.cookieBehavior=5`)
and a separate block-all-cross-site-cookies case (`1`). WebKit uses its default
policy. A first-party positive control accepts an ordinary cookie; cross-site
controls prove blocking in Chromium/WebKit and top-level-site partitioning in
Firefox TCP. Each engine also sets a `Partitioned` cookie in a cross-site frame
and checks whether the next navigation returns it, before running product flows.
When supported, the full delivery matrix runs. Otherwise, private static sites
must show the explanation page while single-file HTML, Markdown, and anonymous
link content still render. Output records the detected capability, engine, exact
version, setting, and completed cases; no engine is skipped.

Supported policies are Chromium with third-party cookie restriction, Firefox
default Total Cookie Protection, and Safari 26.2 or later (and 18.4). Safari 18.5
through 26.1 and browsers blocking all cross-site cookies get the explanation
page for private static sites. Automated WebKit capability detection does not
stand in for a separate Safari product measurement.
A failure is a release blocker, not permission to skip a browser or reuse an old
origin. Authenticated exports and authored HTML/static-site downloads are covered;
the existing anonymous Markdown viewer intentionally has no export menu.

## Workspace search index storage

The application binds `WORKSPACE_SEARCH_INDEX` to the SQLite `WorkspaceSearchIndex` Durable Object. Objects use `${workspaceId}:0`; only partition zero is enabled. Preview appends migration v2 and production appends v3, preserving the live-room migration histories. The public preview configuration schedules only the five-minute trigger; production retains both its five-minute and daily triggers. The private preview overlay requires its own matching binding, migration, and trigger update.

Publication and metadata mutations schedule workspace-only notifications after D1 commits. The five-minute dispatcher also discovers live workspaces and retained `search_index_workspaces` registry entries. That registry deliberately has no workspace foreign key: it keeps deleted source workspaces discoverable until index and extraction cleanup finish. Durable alarms continue bounded inventory scans, pending work, and prefix cleanup after interruption. Failed source reads leave the previous complete generation serving and retain pending work for retry.

Extraction lives under `search-text/<workspace>/<shareable>/<version>/<path-sha256>` in the artifact bucket. The final component is the lowercase hex SHA-256 of the UTF-8 page path; the original path remains in the index document. Ordinary daily orphan reconciliation excludes that prefix. The index owns deletion of superseded, deleted, or moved extraction objects; original upload objects remain under their existing retention rules. Increment `INDEX_FORMAT_VERSION` when extraction or tokenization changes; reconciliation stages replacement generations before activating them. The storage layer provides internal search and detail RPCs; cookie-authenticated search APIs apply live D1 discovery before returning results.

The existing Workers integration harness exercises real HTMLRewriter, FTS5, D1, and R2. Oversized fixtures are generated in memory; they require neither browser rendering nor committed binary fixtures. Publication assertions have a 55-second completion deadline; tests containing multiple publications allow those deadlines within their total test timeout. DO eviction tests dispatch through the scheduled Worker entrypoint so Node-side RPC property proxies do not retain a reference to the object being evicted.


### Full-text search APIs and benchmark

`GET /api/search` accepts `q`, repeated `owner`, `location=home|project`
(with `projectId` for project), `includeArchived=true|false`, `dateField=updated|viewed`,
`days=7|30|90` or `from`/`to`, `sort=relevance|newest`, and `pageSize` (1–50, default 20).
Custom dates accept timezone-bearing instants or UTC calendar days; calendar end days
are inclusive. Results contain `items`, `total`, `tier`, `relaxations`, `nextCursor`
and `searchLogId`. Items include title, owner ID/name, path, plain-text excerpt,
rank, group size and an opaque click receipt. Supply `cursor` with the same query
parameters to continue. Handles expire after 30 minutes and are bound to the actor.

`GET /api/search-suggestions` accepts the same filters and returns `files` (at most
six), `owners` and `projects` (at most three each). It creates no search log.
Typeahead enumerates the eligible owned/viewed/shared IDs once, then restricts
ranking to those IDs before a six-result limit in one RPC per workspace. Owner
and project name queries each return at most three rows. It skips counts,
relaxations and excerpts. Search and detail RPCs only read index storage;
pagination recomputes rankings from the cursor position.

Design: format 9 keeps `search(title, body, script)` unchanged and adds an
empty `search_runs(katakana)` FTS table keyed by chunk ID. Construction never
copies existing chunks. Normal format-version synchronization stages run terms
and deletes them alongside retired chunks. Old generations remain searchable
through segmented terms. Katakana alternatives match the segmented phrase,
segmented-token prefix, or contiguous-run prefix; auxiliary BM25 weight is 0.25
(title/body/script retain 3/1/0.5).

Allowed IDs use read-only UNION ALL JSON bindings of at most 1 MiB each, with
at most ten bindings and 125,000 IDs per workspace. This supports 125,000 standard
36-byte IDs; unusually long IDs may reach the byte limit first. Larger sets
return the typed `search_capacity_exceeded` RPC error, which the service maps
to a private, no-store HTTP 503 instead of returning a partial result. Ranking
is recomputed per continuation; no allowed IDs or ranking cache are stored.

Encrypted cursors and receipts use a per-search key on
the actor-bound log and expire 30 minutes after that log's creation. No separate
cursor or receipt rows are stored. Daily retention drains expired logs in batches of 500, with opened results cascading from each log.
The legacy search palette is unchanged. `GET /api/search-logs` reads only the
caller's most recent 50 searches and at most 500 latest opens across those searches
(ordered by opened time descending, then open ID). Current discovery is checked
in batches of 100 distinct files; inaccessible opens are omitted without refilling
the window. `POST /api/search-logs/:id/opens` accepts
`{"receipt":"…"}` with a same-origin request; file IDs and ranks come from the
authenticated receipt. All new API responses are private and non-cacheable.

After installing the repository's pinned dependencies, run:

```sh
node scripts/measure-workspace-search.mjs --size 100000 --warmup 3 --samples 10
```

The launcher builds first, then runs the existing real Workers integration harness.
Its test-only seed creates D1 eligibility rows and active FTS documents without
rendering pages or running extraction. The Worker measures production member
search for `alpha`, `payload`, `alpha payload` and an empty query, including first-page details, capped counts, group completion,
D1/DO calls and log writes. Seed/setup and Node transport are excluded. The last
seeded file is denied; all other seeded files are eligible. One authorized pair has the same alphabetic
title key to verify exact group sizes. Suggestions and the legacy palette are
measured separately and reported as their own duration arrays. Output reports size, eligibility rate, samples, warmup and p95 milliseconds.
Ordinary post-build integration checks use 40 rows, one warmup and two samples.
The large run is opt-in and has no wall-clock pass threshold.
