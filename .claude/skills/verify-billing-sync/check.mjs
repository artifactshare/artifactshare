#!/usr/bin/env node
// Model-checks Checkout creation and the Stripe subscription sync with TLC.
// Usage: node .claude/skills/verify-billing-sync/check.mjs [--keep]
// The runner is scripts/lib/tlc-check.mjs; this file records what to expect.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runModelChecks } from '../../../scripts/lib/tlc-check.mjs'

// Invariants the current code is known to break. Each entry is a reported
// finding, not a pass. Remove the entry when the code is fixed.
const KNOWN_FINDINGS = {
  AtMostOneBillableSubscription:
    'Two tabs that press Upgrade at once both pass the open-Checkout and subscription checks, so paying both pages starts two subscriptions.',
  SyncedWhenQuiet:
    'A webhook sync that read Stripe before a change can commit after the sync that read it after, so the workspace keeps a plan Stripe no longer bills (or misses one it does).',
}

// One tab and one webhook handler: the scope where neither finding can happen,
// so the mutations below still have a passing baseline to break.
const SEQUENTIAL = { Tabs: '{t1}', ClicksPerTab: '2', Handlers: '{h1}', MaxChanges: '3' }
const SCOPED_BASELINES = [
  { invariant: 'AtMostOneBillableSubscription', constants: SEQUENTIAL },
  { invariant: 'SyncedWhenQuiet', constants: SEQUENTIAL },
]

const MUTATIONS = [
  {
    name: 'checkout-without-expire',
    code: 'createCheckoutSession stops expiring the open Checkout sessions it lists',
    find: 'IF s \\in tab[t].open /\\ sessions[s] = "open" THEN "expired" ELSE sessions[s]]',
    replace: 'sessions[s]]',
    breaks: 'AtMostOneBillableSubscription',
    constants: SEQUENTIAL,
  },
  {
    name: 'checkout-without-subscription-check',
    code: 'createCheckoutSession stops sending a customer with a billable subscription to the portal',
    find: 'tab\' = [tab EXCEPT ![t] = IF BillableSubs # {}',
    replace: 'tab\' = [tab EXCEPT ![t] = IF FALSE',
    breaks: 'AtMostOneBillableSubscription',
    constants: SEQUENTIAL,
  },
  {
    name: 'sync-without-ignore-check',
    code: 'syncWorkspaceSubscription stops ignoring an inactive subscription that is not the one the workspace tracks',
    find: 'ignored == w.subId # 0 /\\ w.subId # h[x].sub /\\ ~(snap.status \\in ActiveStatuses)',
    replace: 'ignored == FALSE',
    breaks: 'SyncedWhenQuiet',
    constants: SEQUENTIAL,
  },
  {
    name: 'plan-ignores-status',
    code: 'derivePlanFromSubscription returns the contract plan whatever the status',
    find: 'DerivedPlan(snap) == IF snap.status \\in ActiveStatuses THEN snap.plan ELSE "free"',
    replace: 'DerivedPlan(snap) == snap.plan',
    breaks: 'SyncedWhenQuiet',
    constants: SEQUENTIAL,
  },
]

await runModelChecks({
  modelDir: join(dirname(fileURLToPath(import.meta.url)), 'model'),
  module: 'BillingSync',
  knownFindings: KNOWN_FINDINGS,
  scopedBaselines: SCOPED_BASELINES,
  mutations: MUTATIONS,
})
