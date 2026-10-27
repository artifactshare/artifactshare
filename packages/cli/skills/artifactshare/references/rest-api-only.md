# REST API only

Read this for direct API integrations. These operations are not supported CLI workflows.

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

Versions added with publisher credentials are scheduled updates: content and live viewers refresh, but list order, feeds, unread indicators, and human update labels do not change. Browser history marks Scheduled update without exposing client names. API `updated_at` remains the actual mutation time; internal `activity_at` controls human activity ordering. Initial creation and versions published through other credentials keep their existing behavior.

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
