---
name: verify-billing-sync
description: Model-check Stripe Checkout creation and the webhook subscription sync with TLA+ (TLC) after a change to apps/web/app/services/billing.server.ts createCheckoutSession, apps/web/app/services/billing-sync.server.ts, or the Stripe webhook route. Use before you call such a change done, and when a plan or double-subscription race is suspected.
---

# Verify billing sync

The owner buys a plan through Stripe Checkout, and Stripe tells Artifact Share about the subscription through webhooks. Stripe can deliver events late, out of order, twice, or to two Workers requests at once, and an owner can press Upgrade in two tabs. Unit tests cover the orders someone wrote down. This check is a TLA+ model of our Stripe calls and D1 writes, with Stripe as the environment, and TLC tries every order of them within the bounds below.

## The rules

Each rule is an INVARIANT in `model/BillingSync.tla`.

| Rule | Plain sentence | Harm if broken |
| --- | --- | --- |
| `AtMostOneBillableSubscription` | The Stripe customer never has two subscriptions that Stripe can bill (`active`, `past_due`). | The owner pays twice. The sync tracks one subscription, so the second one buys nothing. |
| `SyncedWhenQuiet` | Once every webhook event is processed and no sync is running, the workspace plan is the plan of the billable subscription (or free when there is none), and the status the workspace stores for its subscription is Stripe's. | The workspace keeps a paid plan after a cancel, or loses one it pays for, until some later event happens to fix it. |

`TypeOK` is a sanity check on the model's counters.

## When to use

Run the check when a change touches any of these. The model describes them as of the sync commit below. `COVERS` in `check.mjs` lists these files. CI runs this check on a pull request that changes one of them, the model, `check.mjs`, or `scripts/lib/tlc-check.mjs`, and in every merge group.

| Code | Model actions |
| --- | --- |
| `apps/web/app/services/billing.server.ts` `createCheckoutSession` | `TabReadWorkspace`, `TabAcquireLease`, `TabListOpen`, `TabExpire`, `TabListSubscriptions`, `TabEnsureCustomer`, `TabCreateSession`, `TabReleaseLease` |
| same file, `acquireCheckoutLease`, `releaseCheckoutLease` (`workspaces.checkout_lease_token`, `checkout_lease_expires_at`) | `ws.lease`, `TabAcquireLease`, `TabReleaseLease` |
| same file, `ensureStripeCustomer` | `TabEnsureCustomer` |
| same file, `BILLABLE_SUBSCRIPTION_STATUSES`; `apps/web/app/lib/billing-plan.server.ts` `ACTIVE_SUBSCRIPTION_STATUSES` | `BillableStatuses`, `ActiveStatuses` |
| `apps/web/app/services/billing-sync.server.ts` `syncWorkspaceSubscription`, `resolveWorkspaceForSubscription`, `readWorkspaceSubscriptionRow`, `derivePlanFromSubscription` | `SyncReadWorkspace`, `SyncRetrieve`, `DerivedPlan` |
| same file, `writeWorkspaceSubscription`, `commitSync`, `processedMark` (`workspaces.stripe_sync_token`) | `SyncWrite`, `ws.ver` |
| same file, `syncReturnedCheckout` (calls the same sync without an event) | covered by the sync actions |
| `apps/web/app/routes/api.stripe.webhook.tsx` `action`, `recordWebhookEvent` (an event stays pending until its sync commits; a `conflict` answers 500 so Stripe delivers it again) | `pending`, `SyncReadWorkspace`, `SyncWrite` |
| `apps/web/app/routes/_protected/settings/_content/billing.tsx` the `checkout` intent (loads the workspace, then calls `createCheckoutSession`) | `TabReadWorkspace` |

**Sync commit: `1453ba5315206c2426045efa9220327a38c56649`.** To see whether covered code moved since then:

```sh
git diff --stat 1453ba5315206c2426045efa9220327a38c56649 -- $(node -e "import('./.claude/skills/verify-billing-sync/check.mjs').then((m) => console.log(m.COVERS.join(' ')))")
```

If a covered function changed, read the diff against the model before you trust a pass. A pass on a model that no longer matches the code proves nothing.

## Run

From the repository root:

```sh
pnpm check:billing-model
```

It needs Java 11 or later and `curl` on PATH. The runner is `scripts/lib/tlc-check.mjs`. The first run downloads `tla2tools.jar` v1.7.4, checks its SHA-256, and caches it in `~/.cache/artifactshare/`. A run takes about 10 seconds. Pass `--keep` (`node .claude/skills/verify-billing-sync/check.mjs --keep`) to keep the TLC output folders.

The command prints one line per check:

1. **baseline**: one full exploration with every rule that should hold in the full scope.
2. **known finding**: each rule in `KNOWN_FINDINGS` in `check.mjs`, which the current code breaks. Expect `ok ... violated` with the recorded path. The list is empty at the sync commit.
3. **scoped baseline**: each rule in a narrower or deeper scope that a mutation runs in. `SEQUENTIAL` is one tab pressing Upgrade twice, one webhook handler, and up to 3 Stripe changes. `DEEP` is one tab pressing twice, two handlers, and 2 Stripe changes, the smallest scope where an ignored event that keeps the old `stripe_sync_token` lets a stale write win. Expect `ok ... pass`.
4. **mutation**: each entry in `MUTATIONS` is a broken copy of one guard in the code, written as a text change to the model, run in the full scope or the scope it names. Expect `ok ... violated` on the rule that guards it. This shows that each rule can still fail.

It ends with `All checks behaved as recorded.` and exit code 0, or names each check that did not, with the path TLC found and its output file, and exits 1. When a fix lands for a known finding, the finding's line turns into a failure: remove the entry from `KNOWN_FINDINGS` and confirm the rule now passes in the baseline.

## Read a result

Read every TLC result with the pstack `/statechart` skill. Give it `model/BillingSync.tla`, the config, and `model/statechart-view.mjs` as the view. It prints the shortest path to each broken rule in plain words, such as "a webhook reads the subscription", "Stripe changes the subscription", "the webhook saves the plan". Use a scratch copy of the config with one tab if the chart is too busy.

Then decide whether the path is a real bug or a modeling error. Replay it against the code, one step per action:

- Sync paths: `apps/web/app/services/billing-sync.server.test.ts` mocks `runD1Batch` so that `beforeNextWrite.run` runs a step of your choice after a sync has read the workspace and Stripe and before it writes. The tests under "a webhook that read Stripe before a later change" show the pattern: a mutable subscription behind `stripe.subscriptions.retrieve`, and the second sync inside `beforeNextWrite.run`.
- Checkout paths: the tests under "createCheckoutSession with two presses of Upgrade" in `apps/web/app/services/billing.server.test.ts` use a fake Stripe whose `checkout.sessions.list`, `expire`, `create`, and `subscriptions.list` share one in-memory list, and start two calls with `Promise.all`. The awaits interleave the calls the way two Workers requests do.

If the code does what the path says, it is a real bug: report it with that test, and add it to `KNOWN_FINDINGS` only if the user decides not to fix it now. If the code does not, the model is wrong: fix the model so it matches the code. Never weaken a rule or remove a step to make a check pass.

## Update the model for an intended change

1. Find the actions that the changed functions map to in the table above.
2. Make each Stripe API call one action and each D1 statement or `runD1Batch` call one action. Copy the guards, not a summary of them.
3. If a guard text that a mutation targets changed, update its `find` and `replace` in `MUTATIONS`. The run reports a mutation whose text is missing. If you add a guard that a rule depends on, add a mutation for it and confirm it breaks that rule.
4. A fix for a finding usually adds a guard, such as a version or event-time check on the workspace UPDATE, or a lock or idempotency key around Checkout creation. Model the guard as the code writes it, remove the finding from `KNOWN_FINDINGS`, and add a mutation that removes the guard.
5. Run `pnpm check:billing-model` until it reports `All checks behaved as recorded.`
6. Move the sync commit in this file to the commit you checked, only after you confirm that the model describes every covered function at that commit. Update the coverage table if functions were renamed or moved.

## Scope

Verified, full scope (`model/BillingSync.cfg`): every interleaving of 2 tabs pressing Upgrade once each, 2 concurrent webhook handlers, up to 2 Checkout sessions (so up to 2 subscriptions), and 1 Stripe-side change (cancel, failed renewal, recovered renewal, or plan change). Sequential scope: 1 tab pressing twice, 1 handler, up to 3 Stripe-side changes. Deep scope: 1 tab pressing twice, 2 handlers, up to 2 Stripe-side changes. The workspace starts free, with or without a Stripe customer.

Left out:

- Statuses that do not occur here: `trialing`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`. The first-contract access defaults (`link_sharing_enabled` and friends), the `plan.change` audit row, and the storage quota that the sync writes.
- `changePlan` and `previewPlanChange` as our code paths; a plan change appears only as a Stripe-side change.
- Unknown prices and a workspace that the sync cannot find (both return before writing).
- Storage overage billing (`billing-usage.server.ts`), the billing portal itself, and several Stripe customers for one workspace (the `ensureStripeCustomer` race leaves one id in the row, which the model keeps).
- Time. The Checkout lease never expires in the model. In the code it expires after 60 seconds, so a request that still runs after that could race a new press. A Checkout request takes a few Stripe calls, far less than that.
- The retry in `syncWorkspaceSubscription` when `commitSync` cannot see its own token although its write committed (a later sync replaced it). That retry writes what Stripe says at its new read under the same token guard, like any other sync.
- The routing `stripe.subscriptions.retrieve` that only finds the workspace, and the guards on the `plan.change` audit insert.

## Fixed findings

Both rules broke on the code before the sync commit, and both repros are now regression tests.

**`SyncedWhenQuiet`**: `syncWorkspaceSubscription` wrote the workspace with an UPDATE that had no condition on what it read, so a handler that read Stripe before a cancel could commit after the handler that read it after, and leave the workspace on the paid plan. The UPDATE now requires `stripe_sync_token` to be the token it read, writes a new one, and retries from a fresh read when the token moved. An ignored event also writes a new token. Mutations `sync-without-token-check` and `ignored-sync-keeps-token` remove those guards.

**`AtMostOneBillableSubscription`**: two `createCheckoutSession` calls at once both found no open Checkout and no subscription, and both created a session. A per-workspace lease now lets one call at a time run the checks and create the session; the other answers `checkout-in-progress`. Under the lease the call reads the workspace row again. Mutations `checkout-without-lease` and `checkout-trusts-loaded-row` remove those guards.
