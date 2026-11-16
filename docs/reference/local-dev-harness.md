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
Owner suggestions omit file counts to avoid unbounded aggregate queries on each keystroke. They still require a currently discoverable owned/viewed/shared file under the active filters. Bounded collected-file counts remain available on result facets.

Design: blank-query recent history is read newest first in batches of 50 rows,
up to 500 rows per request. Each batch is checked against current discovery and
active filters; stop once six eligible files are collected or history is exhausted.
Denied or out-of-scope recent entries do not consume the six display slots.

Design: typeahead searches the newest 2,000 findable files per indexed source
(owned, viewed, direct shares, project membership and project defaults), with filters
applied before each source limit. Each workspace receives one allowed-ID index call.
Older files outside this domain are omitted; Enter searches the full results domain.
Owner suggestions use a separate D1 query limited to three matching owners with
findable files, including files outside the recent domain. Suggestions include authorized excerpts but omit totals and relaxation queries. Continuation pages also omit relaxation queries.

Design: active members use ranked batches of 2,000 in their current workspace,
without enumerating that workspace. Stop on exhaustion, the requested page plus
1,001 distinct groups, or five fetches. Only first-batch acceptance below 20%
switches to complete allowed-ID retrieval. Five-fetch truncation returns `gte`
even below 1,000 groups; it cannot establish zero for any-word fallback. External
shares and non-member searches retain complete discovery and allowed-ID paging.
Candidate RPC pages contain at most 2,000 IDs. Continuations store no candidate
state: they rerun the same collection window and deterministically merge it before
slicing at the encrypted cursor position. Results outside the five-fetch window
are not returned. Once the collected groups have been consumed there is no next
cursor, even when the total remains a lower bound.

Returned group sizes use indexed `documents.group_key` (the digit-stripped title
key) to page 2,000 matching members per group per workspace, checking D1 discovery
and current titles until exhaustion, 1,000 authorized members, or five batches.
Allowed-ID streams reuse their fully collected, authorized results. This completion is independent of ranking stops;
it generates no tail excerpts. The numeric `groupSize` is capped at 1,000;
`groupSizeRelation` is `eq` when complete and `gte` when capped or when an index
group has unexamined members (even if fewer than 1,000 passed discovery). Group sets also include collected, authorized
hits with the current D1 title key, and the currently authorized representative.
Thus stale or not-yet-rebuilt index keys cannot omit already known members or
produce a group size of zero. Member logs record `search_method=candidates`,
`active_document_count` from the index, and passed candidates plus enumerated external IDs in
`discoverable_count`. Allowed-ID paths record their enumerated eligible count
and `search_method=allowed`.

Query design: MATCH expressions materialize rowids once before joining allowed
documents; they never run once per allowed chunk. Details omit workspace ranks.
Broad terms still require FTS evidence and ordering across all index matches;
that SQL work can exceed the every-file timing target even though D1 candidate
checks and metadata stop early. The active-document count is requested only on
the first candidate fetch and retained for the search log.

Format 12 adds the indexed group key and retains the separate Katakana-run FTS
with weight 0.25 (title/body/script remain 3/1/0.5). Phrase seams retain only the
last 32 and first 32 tokens of adjacent chunks, with no BM25 contribution. Longer
cross-boundary queries still have all-term evidence but may lack phrase evidence.
Normal staged format rebuilding populates this metadata and replaces seams;
search never synchronously rebuilds the index. Allowed IDs use read-only JSON
bindings of at most 1 MiB, split by encoded bytes, without an ID-count ceiling.

Encrypted cursors and receipts use a per-search key on
the actor-bound log and expire 30 minutes after that log's creation. The cursor
contains the merge position; receipts need no rows. Daily retention drains
batches of 500 expired logs to exhaustion, with opened results cascading from
each log; the exact cutoff is retained.
The header uses the full-text suggestions and results endpoints. `GET /api/search-logs` reads only the
caller's most recent 50 searches and at most 500 latest opens per returned search,
with at most 1,000 opens across the request
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
search for `payload` (every file), `rareword` (about 1%), `rareword partner` (about 1% co-occurrence), `lpha` (title substring) and an empty query, including first-page details, capped counts, group completion,
D1/DO calls and log writes. Seed/setup and Node transport are excluded. The last
seeded file is denied; all other seeded files are eligible. One authorized pair has the same alphabetic
title key to verify exact group sizes. Suggestions and the legacy palette are
measured separately. The launcher prints size, eligibility rate, samples, warmup, durations and p95 per query class, plus suggestion and palette p95 milliseconds after success. Each class receives the requested warmup and sample count.
Ordinary post-build integration checks use 40 rows, one warmup and two samples.
The large run is opt-in and has no wall-clock pass threshold.

### Search screen presentation

Cookie-authenticated search responses include project, visibility, activity date and actor-specific last-viewed date. Suggestions include authorized excerpts and blank queries include up to six currently discoverable recent files. First-page facets count distinct authorized collected files, whereas the heading total counts normalized title groups. Facet counts are omitted for lower-bound totals. Pagination stops at 1,000 top-level groups. Results and history include `selectedScope` owner/project names only when current discovery can find a file belonging to that selection; unresolved IDs use neutral UI labels, even in zero-result searches. Video and PDF descriptions remain searchable, but presentation marks these content kinds as bodyless.

`GET /api/search-groups?receipt=...&cursor=...` expands a representative using its actor-bound open receipt. Every read checks current discovery, returns up to 20 other members in newest-first order and issues a separately bound group cursor. No new search log is created. Each expansion or continuation reruns the bounded search collection to include authorized hits whose indexed title key lags behind their current title, then reads group members and checks discovery again. This costs a search collection per group page and can return a search-capacity error; group handles do not cache result bodies or authorized ID sets.

The screen URL translates `project` and `period` into the existing API location/date fields. `dateField`, `from`, `to` and `includeArchived` extend the short URL form to represent the required viewed/custom-date and archive controls. These are cookie-only UI endpoints, not CLI or MCP capabilities.
