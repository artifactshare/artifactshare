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
