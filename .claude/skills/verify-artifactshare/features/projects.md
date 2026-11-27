# Projects

Users create a project in their workspace as a shared destination for files from the same workstream, then share files into it from the UI or the CLI. The project's file list shows those files.

## Sub-features

- `project-create` creates a project from the Projects page.
- `project-create-cli` creates a project with `artifactshare projects create`.
- `project-share-cli` shares a file into a project with `--project <name>` or `--project-id <id>`.
- `project-files` lists the project's files at `/projects/<id>/files`, grouped under the viewer's local date headings, with the file count in the page header.
- `project-archive` archives a project from its menu and lists it, with its file count, at `/projects/archived`.

## How to get to it (user POV)

- Top bar › `Projects` (`/projects`) › `Create`.
- Home › `Projects` rail › `See all`.
- Terminal: `artifactshare projects create <name>`, `artifactshare projects list`, `artifactshare share <path> --project <name>`.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey signs in as `Free owner` and creates its own token.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs`. It prints one `ok` line per step and ends with `PASS projects`. The evidence is in `evidence/projects/`.
- **Create in UI.** On `/projects` (heading `Projects`, level 1), click `Create` (exact). A dialog named `Create project` shows a `Name` textbox, `Add a description`, a group named `Who can view` with two radios whose names start with `Everyone in this workspace` (checked by default) and `Project members only` and go on with their description line, so match them by prefix (`{ name: /^Everyone in this workspace/ }`), and `Cancel` / `Create`. Fill `Name` and click `Create`. The browser moves to `/projects/<id>`, whose level-1 heading is the project name.
- **Share into it.** `runCli(..., ['share', file, '--project', name, '--json'], { token })` exits `0`. `data.destination.type` is `project` with the `project_id`, and `data.share.visibility` is `project`.
- **Project files.** Open `/projects/<id>/files`. A link named with the file title is listed, under one level-2 date heading per calendar day (`Today` for a file shared on the run's day). The page header reads `<file count> · By creation date`, and an empty project shows the `No files yet` state with a zero count. Read a count label from the catalog (`countedLabel(locale, 'project.fileCount', n)`) instead of pinning its wording.
- **Date headings only after hydration.** The heading uses the viewer's time zone, so the server-rendered list has none: a context with `javaScriptEnabled: false` (a copy of the signed-in `storageState`) shows every row and no level-2 heading, and the hydrated page logs no hydration error.
- **Mobile navigation.** At a phone viewport (390x844) `nav[data-bottom-tab-bar]` is visible on the files subpage; at 1280 it is not.
- **Japanese browser.** A context with `locale: 'ja'` shows the Japanese count label and a Japanese date heading (`今日`).
- **Archive.** On `/projects/<id>`, the `Project menu` button opens a menu with `Archive`; its alert dialog `Archive this project?` confirms with `Archive`, and the browser returns to `/projects`. `/projects/archived` (heading `Archived projects`, level 1) lists the project in a `listitem` whose text is `<file count> · Archived <time>`, and keeps both the `Home view` navigation and the bottom tab bar.
- **Create via CLI.** `runCli(..., ['projects', 'create', name, '--json'], { token })` exits `0`. `projects list --json` includes both projects, and `/projects` lists a link named with the CLI project.

## Gotchas

- A Free persona can have 5 projects that are not archived (`PLAN_PROJECT_LIMITS`). The projects journey archives both projects it creates, so it leaves the count as it found it; a hand-driven run that does not archive uses up the slots. If `Create` is refused on a busy run, record the message and retry with `Plus owner` or `Team owner` before calling it a bug.
- A project share defaults to `project` visibility. Pass `--visibility` explicitly when asserting on audience.
- `/projects/archived` also matches `/projects/<id>`, so exclude it when waiting for the new project's URL.
- The date heading appears only after hydration, so wait for the heading instead of reading it right after the file row appears.
- The project page summary and the archived row use the same counted label as the files subpage, so assert the label, not a hand-written count.
