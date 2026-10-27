## Local write recovery

Download accepts only unique artifact IDs matching `^[a-z0-9]{10}$`, including
IDs from list pages and the previous index.
Artifact IDs with surrounding whitespace are rejected, not trimmed, including
single-download targets. Remove the whitespace before retrying. URLs use normal
URL-to-ID resolution. Output parents may be links; their resolved directory identities are rechecked.
Linked output roots, indexes, and listed artifact trees are refused even with `--force`. Preflight checks every listed
artifact tree, including unchanged versions, and the index; unrelated content is
not walked. Network failures and invalid manifest paths, bodies, or identities are recorded per artifact;
every boundary violation stops further publication, including the final index.
Successful replacements retain originals and previous indexes in `data.backup_paths`
and report them in human output. Inspect those paths before manual cleanup.
Failed recovery also names retained paths in the error. Cleanup removes only
CLI-created temporary entries, never containers holding originals. Staging and
backups live in one private directory inside the output root for project
downloads, or in its parent for single downloads. Project index temporary files
use that same private directory so publication stays on the output filesystem.
Identity checks detect observed swaps;
Node path-based operations do not provide atomic confinement against arbitrary
concurrent changes.

Config-mode `init` preserves unknown keys and refuses links at `.artifactshare`
or `config.local.json`. Git worktrees/submodules save config normally but warn
instead of following `.git` files, links, or redirect metadata. Only a real
repository `.git` directory with regular or absent `info/exclude` is updated.
Follow `git_exclude_warning` to add the exact exclude line manually. Onboarding
without config arguments still installs user-scope skills.

Upload aliases use the stored filename for kind, filename, and content type.
Retry `changed` when an enumerated file disappears; correct `not_found` when a
relative path passes through a regular file. Both `share --help` and
`append --help` list `upload_read_failed` and all `validation_failed` reasons:
`link`, `outside_cwd`, `parent_traversal`, `changed`, `not_found`, `invalid_type`,
and `unsupported_guarantee`.
