# @artifactshare/contract

The repository's public CLI, MCP, and agent-facing reference surfaces are
generated from the metadata in this package. Run `pnpm generate:contract-surfaces`
after changing a shared contract; the generator updates the committed CLI help
snapshot, capability matrix, OpenAPI surface, and bundled command tables.

Zod 4 schemas and inferred TypeScript types for the public Artifact Share CLI
API surface.

The package describes the wire payloads used by the CLI and its device
authorization flow. It keeps the API's existing snake_case and camelCase field
names, nullable fields, and legacy refresh request/response shapes intact.

```ts
import {
  CliAuthRefreshRequestSchema,
  CliAuthRefreshResponseSchema,
} from '@artifactshare/contract'

const request = CliAuthRefreshRequestSchema.parse({
  refresh_token: 'asr_refresh',
})
const response = CliAuthRefreshResponseSchema.parse({
  access_token: 'ass_session',
  token_type: 'Bearer',
  expires_at: '2026-12-31T00:00:00.000Z',
})
```

The package contains schemas only; it does not make network requests or change
route behavior.

`ArtifactUploadFormSchema` and `ArtifactVersionUpdateFormSchema` describe an
object projection of multipart forms. Supply `file: form.getAll('file')` for
both schemas, including single-file requests; at least one file is required.
For upload metadata, collect `grant_email` with `getAll` and retain the other
fields as strings when present. In particular, `link_expires_at: "null"` and
`slack_notify: "false"` remain wire strings. Version updates carry only file
parts in the form; their options are in `ArtifactVersionUpdateQuerySchema`.

`MultipartFilePartSchema` checks the portable `name`, `size`, `type`, and
`arrayBuffer()` surface of a file part and preserves the original object and
bytes. It does not reference a global `File` constructor or read file contents.
This structural contract accepts browser and Node file values; endpoint
parsing and content validation remain the server's responsibility.

Device code and token requests require `client_id: CLI_DEVICE_CLIENT_ID`.
A device code request with `project_selector` also requires `preset: "agent"`;
omitting both fields preserves the default authorization flow.

Device verification uses `GET /api/auth/device` with `user_code`; approval and
denial use `userCode` in their POST bodies. Verification lookup is public; the
browser signs in first so the session claims the code before a decision. Its response schema describes only the optional `status`
read by the public adapter. Approval and denial success body schemas are
intentionally omitted because the public adapters inspect HTTP success and
errors without reading response fields. Endpoint error statuses describe
concrete adapter and middleware outcomes, not every possible upstream failure.

### Version labels

Successful update API responses include `number`, a positive integer matching the
Viewer’s `v{number}` for the created version. CLI JSON exposes it as
`data.version.number`, with or without a label. Older server responses may omit
`number`; the CLI accepts them and omits `data.version.number`.

The optional `--label <label>` option on `artifactshare update <target> <path>`
attaches an immutable note to the new version of an HTML file, Markdown file, or static-site
bundle. Labels are normalized to Unicode NFC, then leading and trailing Unicode
space separators (Zs) are trimmed. Internal spacing and case are preserved.
The result must contain 1–80 Unicode code points (not bytes or UTF-16 units).
Letters, marks, numbers, punctuation, symbols, space separators, and U+200D
(joined emoji) are allowed. Empty values, tabs, newlines, controls, bidi formatting
controls, and unpaired surrogates are rejected; labels are never truncated.
CLI validation happens before authentication or upload. For a value beginning
with a known flag, use `--label=--text` to pass it explicitly.

The update API accepts one optional `label` query parameter on
`POST /api/shareables/:id/versions`, including `artifact_kind=static_site` uploads.
Invalid or repeated labels return HTTP 400 `validation-failed` before upload work.
Omission stores NULL and never inherits a prior label. Successful update API
responses include `label`, and CLI JSON includes `data.version.label`: the
normalized, stored label or `null` when omitted. `ArtifactVersionUpdateResponseSchema`
accepts an omitted `label` for compatibility with older servers and preserves
stored labels without normalizing them on read. Existing unlabeled rows are
unchanged. Authorized history at
`GET /api/cli/artifacts/:id?include=versions` includes `label` only when present;
`artifacts get <target> --include versions --json` preserves it. The viewer's
version menu and full history show the label as plain text.
`GET /api/shareables/:id/versions` remains a current-version lookup.
Labels are update-only: initial uploads, `share --key`, `append`, preview,
bridge publishing, and MCP update inputs do not accept them.

### Quoted comment positions

Quoted comments are resolved in the viewer using the exact quote and surrounding context, never the nearest repeated words. `--quote-before` and `--quote-after` accept up to 400 characters per side; preserve spaces next to the quote. Creation does not search the artifact. Optional `anchor.position_state` is `unchecked` until that version is viewed, then `attached` or `needs-check`. Only `attached` maps to `anchor.state: attached`; both other states map to `orphaned`. Older responses may omit `position_state`. Local preview uses the same strict resolution on every reload and preserves the original quote when its position needs checking.

### API-only static-site inheritance

`POST /api/shareables/:id/versions?artifact_kind=static_site` accepts one
`base_version` and repeated `delete_path` query parameters. For example,
`?artifact_kind=static_site&base_version=v1&delete_path=data/old.parquet&delete_path=old.js`
with multipart `file` parts for `data/a.parquet` replaces that data file, removes
the two listed paths, and inherits all other files without copying their objects.
The base must be the current published version; a stale base returns HTTP 409
`version_conflict`. It also supplies the expected version for agent credentials.
If `expected_version` is supplied, it must equal the base (otherwise HTTP 400
`validation-failed`). Neither parameter changes write permissions.

Deletion paths use the same normalization and validation as uploaded paths.
Sending and deleting the same path is invalid. A case-only addition requires
explicitly deleting the old spelling. An absent deletion path is harmless.
A base permits zero sent files, provided the resulting manifest still includes
`index.html` or `index.md`. Entrypoint precedence, file-count, total-size, and
case-collision checks apply to the complete resulting manifest. Without a base,
the existing full replacement behavior applies. Empty or repeated bases,
deletion without a base, and inheritance parameters on other artifact kinds
return HTTP 400 `validation-failed`.

Version size is the logical sum of that version's files. Workspace quota counts
physical objects once across retained versions; only sent files add bytes.
Pruning keeps objects referenced by remaining versions. Version URLs retain
immutable manifests. This is a REST API feature: there are no CLI `update`
flags, MCP inputs, or bridge inputs for inheritance.

### Publisher device credentials (API only)

The device API accepts `preset: "publisher"` with a required `device_name`.
Names are trimmed, NFC-normalized, case-sensitive, and limited to 1–100 Unicode
letters, marks, numbers, ASCII spaces, or `._-()`. The browser approver explicitly
creates a new client or continues one of their existing clients in that workspace.
Names cannot be edited on the approval screen: if a name already exists, continue
that client or request login again with a different name. Only explicit continuation
restores access to earlier files; `device_id` never selects a client.

A publisher can create private HTML, Markdown, or static-site artifacts in the
approver's home. Static sites use `POST /api/shareables/uploads?artifact_kind=static_site`.
It can manage only artifacts created by or assigned to its client, still owned by
that approver in the same workspace, including after the owner shares or moves them.
Single-file versions require `expected_version`. Static-site versions accept
`artifact_kind=static_site` with either `expected_version` for replacement or
`base_version` for changed-files uploads and repeated `delete_path` removals.
The base must be current. Version uploads preserve audience, location and retention.

On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions.

The exact `GET /api/cli/artifacts/:id/download` returns raw source bytes for
single files and a JSON manifest with version id, paths and SHA-256 hashes for
static sites. Individual `download/*` requests are denied. `GET /api/cli/artifacts/:id`
includes visibility; static-site readback contains metadata only. No `include`
expansions are allowed. `DELETE /api/cli/artifacts/:id` deletes the artifact.
POST or PATCH `/api/cli/shareables/:id/edit` accepts only `retain_versions`, a
positive integer or null. Setting a limit prunes older versions immediately;
clearing it never restores deleted content. Other presets remain POST-only.

The owner can assign an existing artifact using an unrestricted credential or
browser session: `POST /api/cli/artifacts/:id/adopt` with
`{"publisher_client_id":"client1"}`. Obtain the verified client id from whoami or
doctor. Assignment replaces the previous client's access and is audited even when
repeated; historical creation attribution stays unchanged. Publisher credentials
cannot adopt. There is no adoption UI or CLI command.

Other clients' artifacts, list, resolve, comments, audience/title/expiry edits,
move, projects, append and upsert remain denied. Existing presets' download and
readback responses are unchanged. CLI publisher login/resume and publishing/download
workflows remain unsupported; use the API. Credentials retain their client across
rotation and can be revoked from Settings → CLI sessions.
