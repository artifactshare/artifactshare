# Projects

Users create a project in their workspace as a shared destination for files from the same workstream, then share files into it from the UI or the CLI. Project members see those files.

## Sub-features

- `project-create` creates a project from the Projects page.
- `project-share-cli` shares a file into a project with `--project <name>` or `--project-id <id>`.
- `project-files` lists the project's files at `/projects/<id>/files`.

## How to get to it (user POV)

- Top bar › `Projects` (`/projects`) › `Create`.
- Home › `Projects` rail › `See all`.
- Terminal: `artifactshare projects create <name>`, `artifactshare projects list`, `artifactshare share <path> --project <name>`.

## Driving it with Playwright and the CLI

Preconditions:

- Signed in as a persona whose plan allows projects. The empty state on `/projects` reads `Projects are created in the Artifact Share Local Dev Free workspace, not in a personal folder.`

- [unobserved] **Create in UI.** On `/projects`, click `getByRole('button', { name: 'Create' })`. Under the heading `Create a project`, enter a marker name and submit. The project page opens, and the project appears on `/projects`.
- [unobserved] **Create via CLI.** `runCli(..., ['projects', 'create', marker, '--json'], { token })` exits `0`, and `projects list --json` includes it.
- [unobserved] **Share into it.** `runCli(..., ['share', file, '--project', marker, '--json'], { token })` exits `0`, and `data.destination.type` is a project.
- [unobserved] **Second view.** Open `/projects/<id>/files`. The shared file's link is listed. Capture it.

## Gotchas

- Free-plan project limits may block a second project. If `Create` is refused, record the message and retry with `Plus owner` or `Team owner` before calling it a bug.
- A project share defaults to `project` visibility. Pass `--visibility` explicitly when asserting on audience.
- Not yet proven end to end in this map.
