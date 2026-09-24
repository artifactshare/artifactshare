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

`artifactshare update <target> <path> --label "Restructured"` attaches an immutable,
optional note to the new version of an HTML file, Markdown file, or static-site
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
Omission stores NULL and never inherits a prior label. Existing unlabeled rows
and response shapes are unchanged. Authorized history at
`GET /api/cli/artifacts/:id?include=versions` includes `label` only when present;
`artifacts get <target> --include versions --json` preserves it. The viewer's
version menu and full history show the label as plain text.
`GET /api/shareables/:id/versions` remains a current-version lookup.
Labels are update-only: initial uploads, `share --key`, `append`, preview,
bridge publishing, and MCP update inputs do not accept them.
