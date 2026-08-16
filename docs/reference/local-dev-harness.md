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
| Artifact sandbox | `https://*.sandbox.localhost:5174` |
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

Preparation is non-destructive by default. If the database differs, inspect the reported difference and run `pnpm dev:setup --reset` explicitly. An isolated state directory can be selected with `--persist-to <directory>`.

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
