### Upload path safety

For `share`, `append`, and `update`, use a regular file or directory (`append`
requires one nonempty UTF-8 file). Relative selections stay in physical cwd and
reject linked components. Absolute selections trust parent directories but reject
a linked selection or included descendant. Never normalize `..`: every such
component is rejected; pass a direct absolute path. Copy linked content into the
selection or pass the target by absolute path. Hidden names, `__MACOSX`, excluded
dependency/metadata directories, and ignored OS filenames are skipped before
inspection. Other entries use `lstat`; cloud placeholders work with stable file
identities. Content is verified before authentication or project lookup, and auth
retries reuse it. `validation_failed` includes `details.path` and `details.reason`:
`parent_traversal`, `link`, `outside_cwd`, `not_found`, `changed`,
`unsupported_guarantee`, or `invalid_type`. Follow the specific hint; retry for
`changed` or `upload_read_failed` (filesystem errno in `details.errno`). POSIX uses
available `O_NOFOLLOW`; Windows uses the same handle identity checks and rejects
links reported by `lstat`. Neither detects every transient swap-and-restore or
same-identity, same-size in-place edit. See the CLI README for the full guarantee.
