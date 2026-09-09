## Change

Describe the implementation and its generalized user-visible effect.

## Validation

List the tests, lint checks, builds, and runtime smoke checks you ran, with their results. Do not include private URLs, customer names, internal specification links, or information that identifies a customer environment.

## Workflow usage

Fill in and update this table before Ready. Record one row for each workflow execution used for this PR: implementation, each Codex or Claude review, repair, retry, failed or interrupted run, and re-review. A paired review is two rows. Keep one execution in one row; do not split it into conversational topic phases. Read native logs and session records manually. Show model and effort as requested → reported. Use `unknown` for missing row values and `partial` or `unknown` for totals; never silently use zero. Publish safe summaries only: omit local log paths, session IDs, and private data.

| Execution                                    | Model (requested → reported) | Effort (requested → reported) | Start–end / elapsed                             |          Input tokens (cache read / write) |    Output tokens | Total tokens | Result                                        |
| -------------------------------------------- | ---------------------------- | ----------------------------- | ----------------------------------------------- | -----------------------------------------: | ---------------: | -----------: | --------------------------------------------- |
| `<implementation / review / repair / retry>` | `<requested → reported>`     | `<requested → reported>`      | `<start → end / elapsed>`                       |       `<input / cache read / cache write>` |       `<output>` |    `<total>` | `<complete / failed / interrupted / unknown>` |
| **PR totals**                                | —                            | —                             | `<earliest → latest / elapsed sum / wall span>` | `<input total / cache read / cache write>` | `<output total>` |    `<total>` | `<complete / partial / unknown>`              |

Input includes cache read and cache write; those cache fields are subsets of input. Include reasoning tokens in output when the provider reports them. Total is normalized input plus output; use top-level category totals and do not add nested values twice. Elapsed total is the sum of per-run elapsed durations. Wall span runs from the earliest included start to the latest included end, including gaps; concurrent runs are not added twice.

## Review

For a substantive change, confirm that Codex and Claude both deeply reviewed the final HEAD with no unresolved blockers, and summarize any follow-ups or non-actionable findings. For an exempt typo or explanatory-documentation change, state why no independent review was needed. Do not include private specification or issue references.
