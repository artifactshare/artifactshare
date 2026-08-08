# Artifact Share

Artifact Share shares HTML, Markdown, folders, and static sites at stable URLs. It supports private, workspace, project, explicit-viewer, and link-based access for work created by people, AI agents, and automation.

**Service:** https://artifactshare.com

## Source-available, not open source

This repository is source-available. You may study, modify, and self-host Artifact Share for your own organization, subject to [the repository license](LICENSE). The license restricts offering Artifact Share as a directly competing hosted, managed, SaaS, or cloud service. It is not an OSI-approved open-source license.

The npm package through version 0.9.0 remains licensed under Apache-2.0. The repository and CLI from version 0.10.0 onward are covered by the source-available license. Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.

## Repository layout

- `apps/web/` — the React Router application and Cloudflare Workers
- `packages/cli/` — the source-available command-line client
- `docs/reference/` — current technical contracts and public-export boundaries
- `docs/brand/` — Artifact Share brand assets and their usage terms
- `proposals/` — public, proposal-only contributions

## Local development and validation

The authoritative setup and export boundary are documented in [the source-available boundary](docs/reference/source-available-boundary.md). A public checkout requires no production credentials or private services.

```sh
pnpm install --frozen-lockfile
pnpm --filter @artifactshare/web exec playwright install --with-deps chrome
pnpm fixtures:build
pnpm db:apply:local
pnpm validate
pnpm test:runtime
```

Run the commands in that order. Local configuration uses fixtures and local service bindings; it does not provide a production deployment path.

## Development process

Artifact Share currently accepts proposal-only pull requests, not code pull requests. Contributors describe a real situation and desired change; maintainers then own the issue, specification, implementation, verification, and release. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a proposal.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), never through a public issue or proposal.

## License

The repository license is a lawyer-review draft with Japanese authoritative text and an English reference translation. See [LICENSE](LICENSE). The npm package through version 0.9.0 remains under Apache-2.0; the repository and CLI from version 0.10.0 onward use the source-available license. Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.
