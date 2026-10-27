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
Omission stores NULL and never inherits a prior label. Successful update API responses include `label`, and CLI JSON includes
`data.version.label`: the normalized, stored label or `null` when omitted.
Authorized history at
`GET /api/cli/artifacts/:id?include=versions` includes `label` only when present;
`artifacts get <target> --include versions --json` preserves it. The viewer's
version menu and full history show the label as plain text.
`GET /api/shareables/:id/versions` remains a current-version lookup.
Labels are update-only: initial uploads, `share --key`, `append`, preview,
bridge publishing, and MCP update inputs do not accept them.
