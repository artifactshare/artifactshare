# Settings and billing

A workspace owner manages the workspace from Settings: members, the admin pages, the workspace name, API tokens, and the Plan and billing page with its plan, subscription state, bill estimate, and storage usage. A member sees the same shell with the admin pages left out and billing read-only.

## Sub-features

- `settings-member-gate` hides `Bots`, `Activity`, and `Inventory` from a member's Settings menu and answers `Access denied` (403) when a member opens `/settings/bots` by URL. The unit test `settings-admin-gate.test.tsx` covers the other admin pages.
- `settings-members` lists the workspace members, with the owner marked `Owner`.
- `settings-rename` lets the owner change the workspace display name on `General`. A member sees the field and `Save` disabled.
- `settings-token-revoke` revokes an API token from `AI tools and CLI`. The token leaves the list and the CLI gets `token_invalid`.
- `billing-plan` shows the plan, the subscription state, and storage usage. Without Stripe values the page says billing is not available.
- `billing-read-only` shows a member the plan with no billing action and a link to `General`.
- `billing-states` covers the Stripe-only states (past due, ending at the period end, storage overage, Free near its limit, a member of a subscribed team) through the dev fixture pages.

## How to get to it (user POV)

- Settings (`/settings`, the `Members` page). Its menu is the `Workspace settings` navigation.
- Settings › `Plan and billing` (`/settings/billing`), `General` (`/settings/general`), `AI tools and CLI` (`/settings/tokens`).
- Dev only: `/dev/settings/<state>/<page>` renders the real Settings pages with fixture loader data. `/dev/screens` lists the states.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey signs in as `Team member`, `Team owner`, and `Free owner`, and creates its own token.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/settings-billing.mjs`. It prints one `ok` line per step and ends with `PASS settings-billing`. The evidence is in `evidence/settings-billing/`.
- **Member view.** As `Team member`, `/settings` shows a table with a row for the `Team owner` persona, marked `Owner`, and the member's own row, and the `Workspace settings` navigation has no `Bots`, `Activity`, or `Inventory` link. `/settings/bots` responds 403 with a heading `Access denied` and a `Back to settings` link.
- **Member billing.** `/settings/billing` as a member shows `Billing is managed by the workspace owner…` (`billing.readOnly.seeGeneral`) and no button in the `Current plan` region. Its `Open general settings` link goes to `/settings/general`, where the `Display name` textbox and `Save` are disabled.
- **Owner view.** As `Team owner`, `/settings` lists the `Team member` persona once the member has signed in, and the menu has `Bots`, `Activity`, and `Inventory`.
- **Billing without Stripe.** The `Current plan` region shows the plan name (`Team`, `Free`), `Not subscribed`, and `Billing is not available yet. Please check back later.` (`billing.unavailable`). The `Storage usage` region's first `strong` is the storage used (`0 B` on a fresh workspace). The Team owner's plan also reads `Not subscribed`.
- **Storage usage.** After a CLI `share` as `Free owner`, a reload of `/settings/billing` shows a larger storage used. The journey's file is about 300 KB, so the change shows even after earlier journeys pushed usage past 1 MB, where the display has one decimal of MB.
- **Rename.** On `/settings/general`, fill `Display name` and click `Save`. The `Location` navigation's first link changes to the new name, after a reload too, and the member's `/settings/general` shows it. The journey renames back to `Artifact Share Local Dev Team`.
- **Revoke a token.** On `/settings/tokens`, the token's row has `Revoke`, which opens an alert dialog `Revoke “<name>”?` with `Cancel` and `Revoke`. After `Revoke` the token's row is gone (on a fresh stack the list reads `No API tokens yet.`), and `whoami --json` with that token exits `1` with `error.code` `token_invalid`.
- **Fixture states.** `/dev/settings/<state>/billing` (any signed-in persona) renders the real billing page with fixture data:
  - `team-past-due`: an `alert` with `billing.pastDue.banner`, `Past due` in `Current plan`, `Open customer portal`, and the estimate note `Unpaid: the <date> charge failed`.
  - `team-cancel-scheduled`: `Ends on <date>` in `Current plan`.
  - `team-overage`: storage used `112.0 GB`, `112%`, and a `12 GB` overage line in `Estimated bill this month`.
  - `free-near-limit`: an `alert` `Storage is almost full` with `Choose a plan from the options on this page…`, and `Choose Plus` / `Choose Team` buttons.
  - `team-member`: the read-only text and no button in `Current plan`.
  - A `ja` phone context (390x844) on `team-past-due` shows the Japanese banner and `<date> の請求が未払い`.

## Gotchas

- Stripe is not configured locally. Checkout (`Choose Plus`), plan changes, and the customer portal are unverified: the fixture pages show the buttons, and clicking them reaches no Stripe. Report those as unverified. A fixture step proves how the page renders a state, not that the webhook sync produces that state; that is the `verify-billing-sync` skill's job.
- The bill estimate formats its dates in the viewer's locale after hydration and renders `—` until then. Wait for the network to go idle before capturing or asserting a date, or the capture shows `— の請求が未払い`.
- The fixture dates are fixed (the period starts 2029-12-01 UTC), so a date in the viewer's time zone can be the day before. Assert that a digit fills the date slot, not the exact date.
- `Team owner` and `Team member` share one workspace, created by whichever signs in first. The member appears in the owner's list only after the member's first sign-in.
- A full-page screenshot at a phone viewport draws the fixed bottom tab bar over the middle of the page. That is the capture, not the layout.
