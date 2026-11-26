# Artifact Share

Artifact Share shares HTML, Markdown, folders, and static sites at stable URLs. It supports private, workspace, project, explicit-viewer, and link-based access for work created by people, AI agents, and automation.

**Service:** https://artifactshare.com

## Source-available, not open source

This repository is source-available. You may study, modify, and self-host Artifact Share for your own organization, subject to [the repository license](LICENSE). The license restricts offering Artifact Share as a directly competing hosted, managed, SaaS, or cloud service. It is not an OSI-approved open-source license.

The npm package through version 0.9.0 remains licensed under Apache-2.0. The repository and CLI from version 0.10.0 onward are covered by the source-available license. Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.

## Repository layout

- `apps/web/` — the React Router application and Cloudflare Workers
- `packages/cli/` — the source-available command-line client
- `docs/reference/` — current technical contracts and repository boundaries
- `docs/brand/` — Artifact Share brand assets and their usage terms
- `proposals/` — public, proposal-only contributions

## Local development and validation

A public checkout requires no production credentials or private services.

```sh
pnpm install --frozen-lockfile
pnpm --filter @artifactshare/web exec playwright install --with-deps chrome
pnpm fixtures:build
pnpm db:apply:local
pnpm validate
pnpm test:runtime
```

Run the commands in that order. Local configuration uses fixtures and local service bindings; it does not provide a production deployment path.

For interactive development, `pnpm dev` prepares local certificates, variables,
and D1 state before starting the application, sandbox, and image worker.

Some screens need states the local stack cannot reach, such as a Stripe
contract whose payment failed, a workspace close to its storage limit, or a
team with members, bots and history. The dev server renders the Settings pages
with fixture data at `/dev/settings/<state>/<page>`, beside the
`/dev/scenarios/<scenario>` pages, and `/dev/screens` lists both. With
`pnpm dev` running, `pnpm screens` captures them into `.screens/`:

```sh
pnpm screens --list
pnpm screens past-due near-limit
pnpm screens team-member
pnpm screens billing --theme light,dark --viewport desktop,mobile --lang ja,en
```

A filter keeps the screens whose id contains it. The states live in
`apps/web/app/routes/dev.settings.$state/+components/settings-states.ts`: the
`free`, `team-subscribed` and `team-member` states cover every page their
Settings menu shows, and the other states cover billing.

The sandbox reporter is maintained in `packages/viewer-kit/src/reporter/*.ts`.
After changing it, run `pnpm --filter @artifactshare/viewer-kit generate:reporter`.
The generated file is deterministic, unformatted output and is excluded from repository formatting.
The generator owns `reporter.generated.ts`, including its exact script body and
CSP hash; include that file with source changes.
Run `node packages/viewer-kit/scripts/build-reporter.mjs --check` to check for drift
without writing files. This check also runs as part of root `pnpm typecheck`.

## Development process

Artifact Share currently accepts proposal-only pull requests, not code pull requests. Contributors describe a real situation and desired change; maintainers then own the issue, specification, implementation, verification, and release. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a proposal.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), never through a public issue or proposal.

## License

The repository license is a lawyer-review draft with Japanese authoritative text and an English reference translation. See [LICENSE](LICENSE). The npm package through version 0.9.0 remains under Apache-2.0; the repository and CLI from version 0.10.0 onward use the source-available license. Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.

Local artifact execution uses versioned `a-…` and `l-…` hosts under
`*.usercontent.localhost` on port 5174. `pnpm dev:setup` includes this certificate
wildcard. The app and public link-viewer URLs are unchanged. All `.localhost`
hosts are same-site, so use the cross-site browser release gate to verify cookie
partitioning; local viewer checks alone are insufficient.
