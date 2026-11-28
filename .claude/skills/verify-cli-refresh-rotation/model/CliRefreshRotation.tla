---------------------------- MODULE CliRefreshRotation ----------------------------
(***************************************************************************)
(* One CLI refresh-credential family of one human user, as stored in D1.  *)
(*                                                                         *)
(* Code: apps/web/app/services/cli-refresh-credentials.server.ts          *)
(*   refreshCliSession            -> RotateRead, RotateBatch, RotateReplay *)
(*   refreshLegacyCliSession      -> LegacyRead, LegacyBatch, LegacyCheck  *)
(*   revokeCliRefreshCredentialFamilyAtomic                                *)
(*                                -> LogoutPrecheck, LogoutBatch           *)
(*   buildCliRefreshCredentialRevocationStatements (deleteSessions: true)  *)
(*                                -> SignOutAllBatch                       *)
(* Code: apps/web/app/services/auth.server.ts (device-token session hook)  *)
(*                                -> DeviceLogin                           *)
(*                                                                         *)
(* Each D1 read is one step. Each runD1Batch call is one step, because D1  *)
(* runs a batch as one transaction. Inside a batch the statements run in   *)
(* code order, and each WHERE sees the writes of the statements before it. *)
(* Expiry, retry windows, bots, and the family authority row are left out. *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Workers,       \* CLI processes that refresh with the tokens they hold
    Requests,      \* rotation_request_id values; two workers that share one model a shared pending_rotation_id
    MaxRefreshes,  \* refresh attempts per worker
    MaxCred,       \* credential ids 1..MaxCred; 1 is the family root (id = family_id)
    MaxSess,       \* session ids 1..MaxSess
    LogoutEnabled  \* FALSE keeps the family alive until sign-out-all (a narrower scope)

Root == 1
NoReq == "none"
CredIds == 1..MaxCred
SessIds == 1..MaxSess

(* cli_refresh_credentials rows. ex = the row exists. *)
NoCred == [ex |-> FALSE, revoked |-> FALSE, replacedBy |-> 0, req |-> NoReq,
           rotSess |-> 0, mark |-> FALSE, parent |-> 0, madeBy |-> NoReq]
(* sessions rows. link = the cli_refresh_sessions row: "family" or "none". *)
NoSess == [ex |-> FALSE, link |-> "none"]

VARIABLES
    cred,        \* CredIds -> credential row
    sess,        \* SessIds -> session row (all are CLI sessions of this user)
    nextCred,    \* next unused credential id (nanoid)
    nextSess,    \* next unused session id (nanoid)
    held,        \* refresh tokens some CLI process has seen (by credential id)
    wk,          \* per-worker program state
    logout,      \* "idle" | "batch" | "done"  (single-family revoke)
    signOut,     \* "idle" | "done"            (revoke every CLI family)
    loggedIn,    \* device login made its session
    replies,     \* ghost: every ok reply, with what was live when it was sent
    leftBehind   \* ghost: sessions alive right after the sign-out-all batch

vars == <<cred, sess, nextCred, nextSess, held, wk, logout, signOut, loggedIn,
          replies, leftBehind>>

Idle(n) == [pc |-> "idle", mode |-> "none", tok |-> 0, req |-> NoReq,
            rid |-> 0, sid |-> 0, n |-> n]

Init ==
    /\ cred = [c \in CredIds |-> IF c = Root
                                 THEN [NoCred EXCEPT !.ex = TRUE]
                                 ELSE NoCred]
    /\ sess = [s \in SessIds |-> NoSess]
    /\ nextCred = 2
    /\ nextSess = 1
    /\ held = {Root}
    /\ wk = [w \in Workers |-> Idle(0)]
    /\ logout = "idle"
    /\ signOut = "idle"
    /\ loggedIn = FALSE
    /\ replies = {}
    /\ leftBehind = {}

-----------------------------------------------------------------------------
(* Predicates the SQL uses. *)

LiveCreds(c) == {i \in CredIds : c[i].ex /\ ~c[i].revoked}
LinkedSessions(s) == {i \in SessIds : s[i].ex /\ s[i].link = "family"}
UnlinkedSessions(s) == {i \in SessIds : s[i].ex /\ s[i].link = "none"}

(* matchingFamilyQuery: an unrevoked credential, or a live linked session. *)
MatchingFamily(c, s) == LiveCreds(c) # {} \/ LinkedSessions(s) # {}

(* activeFamilies() in buildCliRefreshCredentialRevocationStatements. *)
ActiveFamily(c, s) ==
    \/ LiveCreds(c) # {}
    \/ LinkedSessions(s) # {}
    \/ \E i \in CredIds : c[i].ex /\ c[i].mark

DeleteSessions(s, ids) == [i \in SessIds |-> IF i \in ids THEN NoSess ELSE s[i]]

Reply(w, kind, sid, succ, c, s) ==
    [worker |-> w, mode |-> wk[w].mode, tok |-> wk[w].tok, req |-> wk[w].req,
     session |-> sid, succ |-> succ,
     succLive |-> c[succ].ex /\ ~c[succ].revoked,
     sessLive |-> s[sid].ex,
     afterLogout |-> logout = "done",
     afterSignOut |-> signOut = "done"]

Finish(w) == wk' = [wk EXCEPT ![w] = Idle(wk[w].n + 1)]

-----------------------------------------------------------------------------
(* refreshCliSession: the first SELECT on token_hash. *)
RotateRead(w) ==
    /\ wk[w].pc = "idle" /\ wk[w].n < MaxRefreshes
    /\ \E t \in held, r \in Requests :
        IF cred[t].revoked
        THEN \* revoked_at !== null -> readRotationReplay
             /\ wk' = [wk EXCEPT ![w] = [Idle(wk[w].n) EXCEPT !.pc = "replay", !.mode = "rotate",
                                         !.tok = t, !.req = r]]
             /\ UNCHANGED <<nextCred, nextSess>>
        ELSE /\ nextCred <= MaxCred /\ nextSess <= MaxSess
             /\ wk' = [wk EXCEPT ![w] = [Idle(wk[w].n) EXCEPT !.pc = "batch", !.mode = "rotate",
                                         !.tok = t, !.req = r, !.rid = nextCred,
                                         !.sid = nextSess]]
             /\ nextCred' = nextCred + 1
             /\ nextSess' = nextSess + 1
    /\ UNCHANGED <<cred, sess, held, logout, signOut, loggedIn, replies, leftBehind>>

(* refreshCliSession: runD1Batch(rotate, replacement, session, sessionLink, ...) *)
RotateBatch(w) ==
    /\ wk[w].pc = "batch"
    /\ LET t == wk[w].tok
           r == wk[w].req
           rid == wk[w].rid
           sid == wk[w].sid
           \* rotate: WHERE id = current.id AND revoked_at IS NULL
           c1 == IF cred[t].ex /\ ~cred[t].revoked
                 THEN [cred EXCEPT ![t].revoked = TRUE, ![t].replacedBy = rid,
                                   ![t].req = r, ![t].rotSess = sid]
                 ELSE cred
           \* replacement, session: WHERE replaced_by_id = rid AND rotation_request_hash = r
           won == c1[t].replacedBy = rid /\ c1[t].req = r
           c2 == IF won
                 THEN [c1 EXCEPT ![rid] = [NoCred EXCEPT !.ex = TRUE, !.parent = t,
                                                         !.madeBy = r]]
                 ELSE c1
           s3 == IF won THEN [sess EXCEPT ![sid] = [ex |-> TRUE, link |-> "none"]]
                 ELSE sess
           \* sessionLink: FROM cli_refresh_credentials WHERE id = rid
           s4 == IF c2[rid].ex THEN [s3 EXCEPT ![sid].link = "family"] ELSE s3
       IN /\ cred' = c2
          /\ sess' = s4
    /\ wk' = [wk EXCEPT ![w].pc = "replay"]
    /\ UNCHANGED <<nextCred, nextSess, held, logout, signOut, loggedIn, replies, leftBehind>>

(* readRotationReplay *)
RotateReplay(w) ==
    /\ wk[w].pc = "replay"
    /\ LET t == wk[w].tok
           r == wk[w].req
           next == cred[t].replacedBy
           sid == cred[t].rotSess
           found == /\ cred[t].req = r                      \* old.rotation_request_hash = requestHash
                    /\ next # 0 /\ cred[next].ex            \* JOIN next ON next.id = old.replaced_by_id
                    /\ ~cred[next].revoked                  \* next.revoked_at IS NULL
                    /\ sid # 0 /\ sess[sid].ex              \* JOIN sessions ON old.rotation_session_id
       IN IF found
          THEN /\ replies' = replies \cup {Reply(w, "ok", sid, next, cred, sess)}
               /\ held' = held \cup {next}
          ELSE UNCHANGED <<replies, held>>
    /\ Finish(w)
    /\ UNCHANGED <<cred, sess, nextCred, nextSess, logout, signOut, loggedIn, leftBehind>>

-----------------------------------------------------------------------------
(* refreshLegacyCliSession: a request with no rotation_request_id. *)
LegacyRead(w) ==
    /\ wk[w].pc = "idle" /\ wk[w].n < MaxRefreshes
    /\ IF cred[Root].ex /\ ~cred[Root].revoked /\ nextSess <= MaxSess
       THEN /\ wk' = [wk EXCEPT ![w] = [Idle(wk[w].n) EXCEPT !.pc = "legacyBatch", !.mode = "legacy",
                                        !.tok = Root, !.sid = nextSess]]
            /\ nextSess' = nextSess + 1
       ELSE /\ Finish(w)
            /\ UNCHANGED nextSess
    /\ UNCHANGED <<cred, sess, nextCred, held, logout, signOut, loggedIn, replies, leftBehind>>

(* runD1Batch(audit, session, sessionLink, sessionAuthority, used) *)
LegacyBatch(w) ==
    /\ wk[w].pc = "legacyBatch"
    /\ LET sid == wk[w].sid
           \* session: WHERE id = row.id AND revoked_at IS NULL
           s1 == IF ~cred[Root].revoked
                 THEN [sess EXCEPT ![sid] = [ex |-> TRUE, link |-> "none"]]
                 ELSE sess
           \* sessionLink: FROM sessions WHERE id = sessionId
           s2 == IF s1[sid].ex THEN [s1 EXCEPT ![sid].link = "family"] ELSE s1
       IN sess' = s2
    /\ wk' = [wk EXCEPT ![w].pc = "legacyCheck"]
    /\ UNCHANGED <<cred, nextCred, nextSess, held, logout, signOut, loggedIn, replies, leftBehind>>

(* the `committed` SELECT after the batch *)
LegacyCheck(w) ==
    /\ wk[w].pc = "legacyCheck"
    /\ IF sess[wk[w].sid].ex
       THEN replies' = replies \cup {Reply(w, "ok", wk[w].sid, Root, cred, sess)}
       ELSE UNCHANGED replies
    /\ Finish(w)
    /\ UNCHANGED <<cred, sess, nextCred, nextSess, held, logout, signOut, loggedIn, leftBehind>>

-----------------------------------------------------------------------------
(* revokeCliRefreshCredential / revokeCliRefreshCredentialFamily *)
LogoutPrecheck ==
    /\ LogoutEnabled /\ logout = "idle"
    /\ logout' = IF MatchingFamily(cred, sess) THEN "batch" ELSE "done"
    /\ UNCHANGED <<cred, sess, nextCred, nextSess, held, wk, signOut, loggedIn, replies, leftBehind>>

(* runD1Batch(audit, linkedSessions, credentials) *)
LogoutBatch ==
    /\ logout = "batch"
    /\ LET s1 == IF MatchingFamily(cred, sess)
                 THEN DeleteSessions(sess, LinkedSessions(sess)) ELSE sess
           c2 == IF MatchingFamily(cred, s1)
                 THEN [i \in CredIds |-> IF cred[i].ex /\ ~cred[i].revoked
                                         THEN [cred[i] EXCEPT !.revoked = TRUE]
                                         ELSE cred[i]]
                 ELSE cred
       IN /\ sess' = s1
          /\ cred' = c2
    /\ logout' = "done"
    /\ UNCHANGED <<nextCred, nextSess, held, wk, signOut, loggedIn, replies, leftBehind>>

(* revokeAllCliRefreshCredentialFamilies:                                  *)
(* runD1Batch(audit, credentials, preLinkSessions, linkedSessions)         *)
SignOutAllBatch ==
    /\ signOut = "idle"
    /\ LET c1 == IF ActiveFamily(cred, sess)
                 THEN [i \in CredIds |-> IF cred[i].ex /\ ~cred[i].revoked
                                         THEN [cred[i] EXCEPT !.revoked = TRUE, !.mark = TRUE]
                                         ELSE cred[i]]
                 ELSE cred
           s2 == IF ActiveFamily(c1, sess)
                 THEN DeleteSessions(sess, UnlinkedSessions(sess)) ELSE sess
           s3 == IF ActiveFamily(c1, s2)
                 THEN DeleteSessions(s2, LinkedSessions(s2)) ELSE s2
       IN /\ cred' = c1
          /\ sess' = s3
          /\ leftBehind' = {i \in SessIds : s3[i].ex}
    /\ signOut' = "done"
    /\ UNCHANGED <<nextCred, nextSess, held, wk, logout, loggedIn, replies>>

(* auth.server.ts: a device-token sign-in makes an unlinked CLI session.   *)
(* issueCliRefreshCredential would link it to a new family; that call is   *)
(* not taken here, as when the CLI stops between the two requests.         *)
DeviceLogin ==
    /\ ~loggedIn /\ nextSess <= MaxSess
    /\ sess' = [sess EXCEPT ![nextSess] = [ex |-> TRUE, link |-> "none"]]
    /\ nextSess' = nextSess + 1
    /\ loggedIn' = TRUE
    /\ UNCHANGED <<cred, nextCred, held, wk, logout, signOut, replies, leftBehind>>

AllDone ==
    /\ \A w \in Workers : wk[w].pc = "idle"
    /\ UNCHANGED vars

Next ==
    \/ \E w \in Workers :
        \/ RotateRead(w) \/ RotateBatch(w) \/ RotateReplay(w)
        \/ LegacyRead(w) \/ LegacyBatch(w) \/ LegacyCheck(w)
    \/ LogoutPrecheck \/ LogoutBatch
    \/ SignOutAllBatch
    \/ DeviceLogin
    \/ AllDone

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules *)

(* A credential is rotated into at most one live successor: the family     *)
(* never forks into two refresh tokens that both work.                     *)
NoFork == Cardinality(LiveCreds(cred)) <= 1

(* An ok reply from rotation hands out a refresh token and a session that  *)
(* both work at the moment the reply is built.                             *)
RotationRepliesAreLive ==
    \A x \in replies : x.mode = "rotate" => (x.succLive /\ x.sessLive)

(* A rotation reply goes only to the request that made the rotation: the  *)
(* same old token and the same rotation_request_id.                        *)
RepliesMatchTheirRotation ==
    \A x \in replies :
        x.mode = "rotate" => (cred[x.succ].parent = x.tok /\ cred[x.succ].madeBy = x.req)

FamilyDead == LiveCreds(cred) = {} /\ LinkedSessions(sess) = {}

(* After a logout (or "revoke this CLI") finishes, the family has no       *)
(* working refresh token or session, and no refresh succeeds again.        *)
LogoutIsFinal ==
    logout = "done" => (FamilyDead /\ \A x \in replies : ~x.afterLogout)

(* After "sign out every CLI" finishes, the family has no working refresh  *)
(* token or session, and no refresh succeeds again.                        *)
SignOutAllIsFinal ==
    signOut = "done" => (FamilyDead /\ \A x \in replies : ~x.afterSignOut)

(* "Sign out every CLI" leaves no CLI session of the user alive, including *)
(* a device-login session that no family has linked yet.                   *)
SignOutAllEndsEveryCliSession ==
    signOut = "done" => leftBehind = {}

TypeOK ==
    /\ nextCred \in 2..(MaxCred + 1)
    /\ nextSess \in 1..(MaxSess + 1)
    /\ held \subseteq CredIds
=============================================================================
