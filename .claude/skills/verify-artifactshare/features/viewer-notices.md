# Viewer notices

The viewer tells people two things along the bottom edge: the sandbox security banner, when the file asked for resources the sandbox blocked, and toasts, when something the person did needs an answer. On a phone the comment sheet takes that edge, so a toast moves up above it and keeps reading above the banner.

## Sub-features

- `security-banner` lists the blocked resources for the file being viewed, with a count and an expandable `What was blocked` section.
- `toast-placement` lifts toasts above the comment sheet while it is open and drops them back when it closes.
- `toast-copy-recovery` shows the link to copy by hand when the browser refuses the clipboard, with a close button and, where the caller offers it, an `Open sharing settings` action.
- `toast-over-consent` keeps a toast readable above the analytics consent banner, which takes the same bottom edge.

## How to get to it (user POV)

- Viewer (`/a/<id>`) of a file whose HTML loads scripts, stylesheets, or frames from an origin the sandbox does not allow (the allowlisted CDNs, such as `cdn.jsdelivr.net`, are not blocked): the banner appears under the file, above the version chip.
- Viewer › `Comments` › a thread › `More actions` › `Copy link`. With a browser that allows the clipboard this shows `Copied`; with one that refuses it (a locked-down browser, a sandboxed frame, an insecure origin) it shows the recovery toast instead.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey shares its own file and creates its own token.
- The file has to ask for enough blocked resources for the banner to reach its full height (`max-h-96`), or the banner never reaches the band the toast uses. 14 external scripts and a stylesheet do.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/viewer-notices.mjs`. It prints one `ok` line per step and ends with `PASS viewer-notices`. The evidence is in `evidence/viewer-notices/`.
- **Security banner.** Open the viewer. A `status` region reads `⚠ Security blocked <n> resources` (`csp.banner.summaryOne`/`Other`). Click the summary `What was blocked · File` (`csp.banner.detailsSummary`, then the group) and it lists one line per blocked resource, each with its directive (`script-src-elem`, `style-src-elem`, `frame-src`) and URL. Expanded with 15 resources it is 358×384 at the phone width below, 72px above the bottom edge.
- **Phone.** Build the viewport with `browser.newContext({ storageState, viewport: { width: 390, height: 844 } })`, and refuse the clipboard in the same context with `addInitScript` (`navigator.clipboard.writeText` rejects, `document.execCommand` returns `false`). That is what a browser that denies clipboard access does.
- **Comment sheet.** Click `getByRole('button', { name: 'Comments', exact: true })`. The dialog named `Comments` becomes a sheet along the bottom: 370×340 (`--height-comment-panel-sheet`), its bottom on the viewport's bottom edge. It slides in, so read its box with `stableBox`.
- **Toast.** In a thread, `More actions` › `Copy link`. The toast is `[data-sonner-toast]`, holds `Couldn't copy · copy this link manually` with the link below it, and a button named `Close notification` (`toast.close`, `通知を閉じる` in Japanese). It has no timeout, so it can be measured and the sheet closed under it.
- **Placement.** With the sheet open the toast sits fully above it (bottom `492`, sheet top `504`) and over the banner (banner top `388`), and `document.elementFromPoint` at nine points inside the toast returns the toast or its children. Closing the sheet drops the same toast to the bottom offset (bottom `828` of `844`).
- **Over the consent banner.** With the sheet closed and the toast still up, the account button › `Analytics settings` (`analyticsConsent.change`) opens the consent banner, a `region` named `Analytics consent`, along the bottom edge: 366×118 against the toast's 358×112, so the toast sits inside it. The toast still answers `elementFromPoint` at all nine points, because it paints above the banner's `--z-consent-banner` (40).
- **Second view.** The capture of each state (`05-toast-above-sheet`, `06-toast-sheet-closed`, `07-toast-over-consent-banner`) shows the toast over the banner it shares the edge with.

## Gotchas

- Blocking is per directive: external scripts, stylesheets, and frames are reported, but images and media are not blocked by the sandbox's policy, so they do not add to the count and do go out to the network. Use scripts for a fixture.
- `frame-src` is reported once per origin, not per URL. Distinct script URLs are the reliable way to raise the count.
- The banner and the comment sheet are both `z-50`, and the sheet is portalled later, so the sheet covers the banner. Only the toast is expected above both.
- The sheet and the toast animate in. A box read straight after `waitFor` can be a frame of the animation; `stableBox` waits for two equal reads.
- On desktop the offset while the panel is open (`var(--spacing-6)`, 24px) is the same as sonner's own default, so the lift is only visible at phone widths.
- The security banner sits inside the page's own stacking context, below every positioned element at the body level, so the toast is above it whatever the toaster's `z-index` is. The analytics consent banner is the toaster's sibling at the body level, so there `z-index` is what decides, and that is where a lowered toast is seen.
- A modal dialog (`Change who can view`) puts `pointer-events: none` on the body, and the toast inherits it. It is still painted above the dialog, but `elementFromPoint` answers the dialog overlay, so do not measure the toast's place over a modal dialog.
- `getByRole('button', { name: 'Comments', exact: true })` matches the top bar button; in Japanese it is `コメント`.
