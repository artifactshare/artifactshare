#!/usr/bin/env node
// Model-checks Checkout creation and the Stripe subscription sync with TLC.
// Usage: node .claude/skills/verify-billing-sync/check.mjs [--keep]
// The runner is scripts/lib/tlc-check.mjs; this file records what to expect.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runModelChecks } from '../../../scripts/lib/tlc-check.mjs'

export const COVERS = [
  'apps/web/app/services/billing.server.ts',
  'apps/web/app/services/billing-sync.server.ts',
  'apps/web/app/routes/api.stripe.webhook.tsx',
  'apps/web/app/lib/billing-plan.server.ts',
  'apps/web/app/routes/_protected/settings/_content/billing.tsx',
]

// Invariants the current code is known to break. Each entry is a reported
// finding, not a pass. Remove the entry when the code is fixed.
const KNOWN_FINDINGS = {}

// One tab and one webhook handler: the mutations of guards that matter even
// without concurrency run here.
const SEQUENTIAL = { Tabs: '{t1}', ClicksPerTab: '2', Handlers: '{h1}', MaxChanges: '3' }
// A deeper scope: two Checkout pages from one tab, two handlers, two Stripe
// changes. It is the smallest scope where an ignored event that leaves the
// token alone lets a stale write win.
const DEEP = { Tabs: '{t1}', ClicksPerTab: '2', Handlers: '{h1, h2}', MaxChanges: '2' }
const SCOPED_BASELINES = [
  { invariant: 'AtMostOneBillableSubscription', constants: SEQUENTIAL },
  { invariant: 'SyncedWhenQuiet', constants: SEQUENTIAL },
  { invariant: 'SyncedWhenQuiet', constants: DEEP, label: 'deep' },
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
  {
    name: 'sync-without-token-check',
    code: 'syncWorkspaceSubscription writes without WHERE stripe_sync_token IS the token it read',
    find: 'current == ws.ver = w.ver',
    replace: 'current == TRUE',
    breaks: 'SyncedWhenQuiet',
  },
  {
    name: 'ignored-sync-keeps-token',
    code: 'syncWorkspaceSubscription stops writing a new stripe_sync_token when it ignores an event',
    find: 'ELSE IF ignored THEN [ws EXCEPT !.ver = ws.ver + 1]',
    replace: 'ELSE IF ignored THEN ws',
    breaks: 'SyncedWhenQuiet',
    constants: DEEP,
  },
  {
    name: 'checkout-without-lease',
    code: 'createCheckoutSession goes on when another request holds the Checkout lease',
    find: 'IF ws.lease = "none"',
    replace: 'IF TRUE',
    breaks: 'AtMostOneBillableSubscription',
  },
  {
    name: 'checkout-trusts-loaded-row',
    code: 'createCheckoutSession decides from the row loaded before the lease, which may show no Stripe customer yet',
    find: 'ELSE IF ws.customer                    \\* existingCustomer',
    replace: 'ELSE IF FALSE',
    breaks: 'AtMostOneBillableSubscription',
  },
]

if (import.meta.main)
  await runModelChecks({
    modelDir: join(dirname(fileURLToPath(import.meta.url)), 'model'),
    module: 'BillingSync',
    knownFindings: KNOWN_FINDINGS,
    scopedBaselines: SCOPED_BASELINES,
    mutations: MUTATIONS,
  })
