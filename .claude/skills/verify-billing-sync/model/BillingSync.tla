------------------------------- MODULE BillingSync -------------------------------
(***************************************************************************)
(* One workspace and its Stripe customer, with Stripe as the environment.  *)
(*                                                                         *)
(* Code: apps/web/app/services/billing.server.ts                          *)
(*   createCheckoutSession  -> TabReadWorkspace, TabAcquireLease,          *)
(*                             TabListOpen, TabExpire,                     *)
(*                             TabListSubscriptions, TabEnsureCustomer,    *)
(*                             TabCreateSession, TabReleaseLease           *)
(*   acquireCheckoutLease, releaseCheckoutLease -> ws.lease                *)
(* Code: apps/web/app/services/billing-sync.server.ts                     *)
(*   syncWorkspaceSubscription (and syncReturnedCheckout, which calls it)  *)
(*                          -> SyncReadWorkspace, SyncRetrieve, SyncWrite  *)
(*   (its first retrieve only finds the workspace and writes nothing)      *)
(*   workspaces.stripe_sync_token -> ws.ver: each write sets a fresh       *)
(*   nanoid, which the model writes as a counter that only goes up.        *)
(* Code: apps/web/app/routes/api.stripe.webhook.tsx                       *)
(*   action: an event stays pending until a sync for it commits; Stripe   *)
(*   may deliver it again, out of order, or to two handlers at once.       *)
(* Stripe itself (not our code):                                           *)
(*   a Checkout completes, a subscription is canceled, a payment fails or *)
(*   recovers, the plan changes. Each change queues one webhook event.    *)
(*                                                                         *)
(* Each Stripe API call and each D1 statement or batch is one step.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tabs,          \* browser tabs where the owner presses "Upgrade"
    ClicksPerTab,  \* times each tab presses it
    Handlers,      \* concurrent webhook handlers (Workers requests)
    MaxSessions,   \* Checkout sessions Stripe can create; also bounds subscriptions
    MaxChanges     \* cancels, payment failures/recoveries, and plan changes Stripe makes

Plans == {"plus", "team"}
SessIds == 1..MaxSessions
SubIds == 1..MaxSessions          \* the subscription a session creates has the session's id
EvIds == 1..(MaxSessions + MaxChanges)
ActiveStatuses == {"active", "past_due"}             \* ACTIVE_SUBSCRIPTION_STATUSES (no trials here)
BillableStatuses == {"active", "past_due"}           \* BILLABLE_SUBSCRIPTION_STATUSES that occur here

NoSub == [ex |-> FALSE, status |-> "none", plan |-> "plus"]

VARIABLES
    subs,        \* Stripe subscriptions of the customer
    sessions,    \* Stripe Checkout sessions: "none" | "open" | "complete" | "expired"
    sessPlan,    \* plan each session sells
    nextSess,
    changes,     \* Stripe-side changes made so far
    pending,     \* webhook events not yet processed
    evSub,       \* the subscription each event is about
    nextEv,
    ws,          \* the workspaces row
    tab,         \* per-tab program state of createCheckoutSession
    h            \* per-handler program state of the webhook sync

vars == <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, tab, h>>

TabIdle(n) == [pc |-> "idle", clicks |-> n, plan |-> "plus", open |-> {}]
HIdle == [pc |-> "idle", ev |-> 0, sub |-> 0, snap |-> NoSub,
          wsSnap |-> [subId |-> 0, status |-> "none", plan |-> "free", ver |-> 0]]

Init ==
    /\ subs = [s \in SubIds |-> NoSub]
    /\ sessions = [s \in SessIds |-> "none"]
    /\ sessPlan = [s \in SessIds |-> "plus"]
    /\ nextSess = 1
    /\ changes = 0
    /\ pending = {}
    /\ evSub = [e \in EvIds |-> 0]
    /\ nextEv = 1
    /\ ws \in [subId : {0}, status : {"none"}, plan : {"free"}, customer : BOOLEAN,
               ver : {0}, lease : {"none"}]
    /\ tab = [t \in Tabs |-> TabIdle(0)]
    /\ h = [x \in Handlers |-> HIdle]

Billable(s) == subs[s].ex /\ subs[s].status \in BillableStatuses
BillableSubs == {s \in SubIds : Billable(s)}

(* derivePlanFromSubscription *)
DerivedPlan(snap) == IF snap.status \in ActiveStatuses THEN snap.plan ELSE "free"

-----------------------------------------------------------------------------
(* createCheckoutSession, one tab. The action loads the workspace first.   *)
TabReadWorkspace(t) ==
    /\ tab[t].pc = "idle" /\ tab[t].clicks < ClicksPerTab
    /\ \E p \in Plans :
        tab' = [tab EXCEPT ![t] =
                  IF ws.plan # "free"                     \* isPaidPlan -> already-subscribed
                  THEN TabIdle(tab[t].clicks + 1)
                  ELSE [TabIdle(tab[t].clicks) EXCEPT !.pc = "acquire", !.plan = p]]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, h>>

(* acquireCheckoutLease: a conditional UPDATE of workspaces. A tab that  *)
(* does not get it answers checkout-in-progress. With the lease held, the *)
(* workspace row is read again (plan, stripe_customer_id).                *)
TabAcquireLease(t) ==
    /\ tab[t].pc = "acquire"
    /\ IF ws.lease = "none"
       THEN /\ ws' = [ws EXCEPT !.lease = t]
            /\ tab' = [tab EXCEPT ![t] =
                         IF ws.plan # "free"
                         THEN [tab[t] EXCEPT !.pc = "release"]
                         ELSE IF ws.customer                    \* existingCustomer
                              THEN [tab[t] EXCEPT !.pc = "listOpen"]
                              ELSE [tab[t] EXCEPT !.pc = "ensure"]]
       ELSE /\ tab' = [tab EXCEPT ![t] = TabIdle(tab[t].clicks + 1)]
            /\ UNCHANGED ws
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, h>>

(* releaseCheckoutLease in the finally block: only the holder clears it *)
TabReleaseLease(t) ==
    /\ tab[t].pc = "release"
    /\ ws' = [ws EXCEPT !.lease = IF ws.lease = t THEN "none" ELSE ws.lease]
    /\ tab' = [tab EXCEPT ![t] = TabIdle(tab[t].clicks + 1)]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, h>>

(* stripe.checkout.sessions.list({ status: 'open' }) *)
TabListOpen(t) ==
    /\ tab[t].pc = "listOpen"
    /\ tab' = [tab EXCEPT ![t].pc = "expire",
                          ![t].open = {s \in SessIds : sessions[s] = "open"}]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, h>>

(* stripe.checkout.sessions.expire for each listed session; one that       *)
(* completed in between stays complete.                                   *)
TabExpire(t) ==
    /\ tab[t].pc = "expire"
    /\ sessions' = [s \in SessIds |->
                      IF s \in tab[t].open /\ sessions[s] = "open" THEN "expired" ELSE sessions[s]]
    /\ tab' = [tab EXCEPT ![t].pc = "listSubs"]
    /\ UNCHANGED <<subs, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, h>>

(* stripe.subscriptions.list: a billable one sends the owner to the portal *)
TabListSubscriptions(t) ==
    /\ tab[t].pc = "listSubs"
    /\ tab' = [tab EXCEPT ![t] = IF BillableSubs # {}
                                 THEN [tab[t] EXCEPT !.pc = "release"]
                                 ELSE [tab[t] EXCEPT !.pc = "ensure"]]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, h>>

(* ensureStripeCustomer: the conditional UPDATE keeps one customer id *)
TabEnsureCustomer(t) ==
    /\ tab[t].pc = "ensure"
    /\ ws' = [ws EXCEPT !.customer = TRUE]
    /\ tab' = [tab EXCEPT ![t].pc = "create"]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, h>>

(* stripe.checkout.sessions.create; the owner is redirected to it *)
TabCreateSession(t) ==
    /\ tab[t].pc = "create"
    /\ nextSess <= MaxSessions
    /\ sessions' = [sessions EXCEPT ![nextSess] = "open"]
    /\ sessPlan' = [sessPlan EXCEPT ![nextSess] = tab[t].plan]
    /\ nextSess' = nextSess + 1
    /\ tab' = [tab EXCEPT ![t].pc = "release"]
    /\ UNCHANGED <<subs, changes, pending, evSub, nextEv, ws, h>>

-----------------------------------------------------------------------------
(* Stripe *)

(* Stripe queues one webhook event for the change. *)
Emit(s) ==
    /\ pending' = pending \cup {nextEv}
    /\ evSub' = [evSub EXCEPT ![nextEv] = s]
    /\ nextEv' = nextEv + 1

(* The owner pays on an open Checkout page. *)
StripeCompleteCheckout ==
    \E s \in SessIds :
        /\ sessions[s] = "open"
        /\ sessions' = [sessions EXCEPT ![s] = "complete"]
        /\ subs' = [subs EXCEPT ![s] = [ex |-> TRUE, status |-> "active", plan |-> sessPlan[s]]]
        /\ Emit(s)
        /\ UNCHANGED <<sessPlan, nextSess, changes, ws, tab, h>>

StripeChange ==
    /\ changes < MaxChanges
    /\ \E s \in SubIds, next \in {"active", "past_due", "canceled"}, p \in Plans :
        /\ subs[s].ex /\ subs[s].status # "canceled"
        /\ \/ next = "canceled"                                     \* canceled in the portal
           \/ subs[s].status = "active" /\ next = "past_due" /\ p = subs[s].plan   \* a renewal fails
           \/ subs[s].status = "past_due" /\ next = "active" /\ p = subs[s].plan   \* the retry succeeds
           \/ subs[s].status = "active" /\ next = "active" /\ p # subs[s].plan     \* plan change
        /\ next = "canceled" => p = subs[s].plan
        /\ subs' = [subs EXCEPT ![s] = [ex |-> TRUE, status |-> next, plan |-> p]]
        /\ Emit(s)
        /\ changes' = changes + 1
        /\ UNCHANGED <<sessions, sessPlan, nextSess, ws, tab, h>>

-----------------------------------------------------------------------------
(* Webhook handler -> syncWorkspaceSubscription *)

(* readWorkspaceSubscriptionRow: the workspace row, including            *)
(* stripe_sync_token, read before Stripe is asked. *)
SyncReadWorkspace(x) ==
    /\ h[x].pc = "idle"
    /\ \E e \in pending :
        h' = [h EXCEPT ![x] = [HIdle EXCEPT !.pc = "retrieve", !.ev = e, !.sub = evSub[e],
                                            !.wsSnap = [subId |-> ws.subId, status |-> ws.status,
                                                        plan |-> ws.plan, ver |-> ws.ver]]]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, tab>>

(* stripe.subscriptions.retrieve *)
SyncRetrieve(x) ==
    /\ h[x].pc = "retrieve"
    /\ h' = [h EXCEPT ![x].pc = "write", ![x].snap = subs[h[x].sub]]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, pending, evSub, nextEv, ws, tab>>

(* writeWorkspaceSubscription -> commitSync: runD1Batch(audit, UPDATE      *)
(* workspaces ... WHERE stripe_sync_token IS the token read, mark           *)
(* billing_webhook_events processed WHERE the row holds this sync's token). *)
(* The 'ignored' case writes only a new token, so a sync that read Stripe   *)
(* before it cannot commit after it. When the token moved, nothing is       *)
(* written, the event stays pending, and the sync starts over (up to 3      *)
(* times, then the webhook answers 500 and Stripe delivers it again).       *)
SyncWrite(x) ==
    /\ h[x].pc = "write"
    /\ LET snap == h[x].snap
           w == h[x].wsSnap
           ignored == w.subId # 0 /\ w.subId # h[x].sub /\ ~(snap.status \in ActiveStatuses)
           current == ws.ver = w.ver
       IN /\ ws' = IF ~current THEN ws
                   ELSE IF ignored THEN [ws EXCEPT !.ver = ws.ver + 1]
                   ELSE [ws EXCEPT !.subId = h[x].sub, !.status = snap.status,
                                   !.plan = DerivedPlan(snap), !.ver = ws.ver + 1]
          /\ pending' = IF current THEN pending \ {h[x].ev} ELSE pending
    /\ h' = [h EXCEPT ![x] = HIdle]
    /\ UNCHANGED <<subs, sessions, sessPlan, nextSess, changes, evSub, nextEv, tab>>

Quiet ==
    /\ pending = {}
    /\ \A x \in Handlers : h[x].pc = "idle"

Done ==
    /\ Quiet
    /\ \A t \in Tabs : tab[t].pc = "idle"
    /\ UNCHANGED vars

Next ==
    \/ \E t \in Tabs :
        \/ TabReadWorkspace(t) \/ TabAcquireLease(t) \/ TabReleaseLease(t)
        \/ TabListOpen(t) \/ TabExpire(t)
        \/ TabListSubscriptions(t) \/ TabEnsureCustomer(t) \/ TabCreateSession(t)
    \/ StripeCompleteCheckout
    \/ StripeChange
    \/ \E x \in Handlers : SyncReadWorkspace(x) \/ SyncRetrieve(x) \/ SyncWrite(x)
    \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules *)

(* The customer never has two subscriptions that Stripe can bill. The sync *)
(* tracks one, so a second one charges the owner without giving a plan.   *)
AtMostOneBillableSubscription == Cardinality(BillableSubs) <= 1

(* Once every webhook event is processed and no sync is running, the       *)
(* workspace plan is what Stripe bills for: the plan of the billable       *)
(* subscription, or free when there is none, and the status the workspace  *)
(* stores for its subscription is Stripe's.                                *)
SyncedWhenQuiet ==
    Quiet =>
        /\ ws.plan = (IF BillableSubs = {} THEN "free"
                      ELSE IF Cardinality(BillableSubs) = 1
                           THEN subs[CHOOSE s \in BillableSubs : TRUE].plan
                           ELSE ws.plan)
        /\ ws.subId # 0 => ws.status = subs[ws.subId].status

TypeOK ==
    /\ nextSess \in 1..(MaxSessions + 1)
    /\ pending \subseteq EvIds
    /\ ws.plan \in {"free"} \cup Plans
=============================================================================
