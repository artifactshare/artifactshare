# Projects

Users create a project in their workspace as a shared destination for files from the same workstream, then share files into it from the UI or the CLI. The project's file list shows those files.

## Sub-features

- `project-create` creates a project from the Projects page.
- `project-create-cli` creates a project with `artifactshare projects create`.
- `project-share-cli` shares a file into a project with `--project <name>` or `--project-id <id>`.
- `project-files` lists the project's files at `/projects/<id>/files`.

## How to get to it (user POV)

- Top bar › `Projects` (`/projects`) › `Create`.
- Home › `Projects` rail › `See all`.
- Terminal: `artifactshare projects create <name>`, `artifactshare projects list`, `artifactshare share <path> --project <name>`.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey signs in as `Free owner` and creates its own token.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs`. It prints one `ok` line per step and ends with `PASS projects`. The evidence is in `evidence/projects/`.
- **Create in UI.** On `/projects` (heading `Projects`, level 1), click `Create` (exact). A dialog named `Create project` shows a `Name` textbox, `Add a description`, a `Who can view` radio group (`Everyone in this workspace`, checked by default, or `Project members only`), and `Cancel` / `Create`. Fill `Name` and click `Create`. The browser moves to `/projects/<id>`, whose level-1 heading is the project name.
- **Share into it.** `runCli(..., ['share', file, '--project', name, '--json'], { token })` exits `0`. `data.destination.type` is `project` with the `project_id`, and `data.share.visibility` is `project`.
- **Project files.** Open `/projects/<id>/files`. A link named with the file title is listed.
- **Create via CLI.** `runCli(..., ['projects', 'create', name, '--json'], { token })` exits `0`. `projects list --json` includes both projects, and `/projects` lists a link named with the CLI project.

## Gotchas

- A Free persona can create at least two projects. If `Create` is refused on a busy run, record the message and retry with `Plus owner` or `Team owner` before calling it a bug.
- A project share defaults to `project` visibility. Pass `--visibility` explicitly when asserting on audience.
- `/projects/archived` also matches `/projects/<id>`, so exclude it when waiting for the new project's URL.
