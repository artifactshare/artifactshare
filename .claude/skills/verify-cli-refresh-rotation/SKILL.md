---
name: verify-cli-refresh-rotation
description: Model-check CLI refresh-token rotation, logout, and "sign out every CLI" with TLA+ (TLC) after a change to apps/web/app/services/cli-refresh-credentials.server.ts or the CLI device-login session. Use before you call such a change done, and when a refresh or revoke race is suspected.
---

# Verify CLI refresh rotation

The CLI keeps a refresh token and trades it for a new refresh token and a session at `POST /api/cli/auth/refresh`. Two CLI processes that share a profile can send the same refresh token at once, and a logout or "sign out every CLI" can land between any two database calls. Unit tests cover the orders someone wrote down. This check is a TLA+ model of the D1 reads and batches, and TLC tries every order of them within the bounds below.

## The rules

Each rule is an INVARIANT in `model/CliRefreshRotation.tla`.

| Rule | Plain sentence | Harm if broken |
| --- | --- | --- |
| `NoFork` | A refresh token is rotated into at most one working successor. | A stolen or duplicated token keeps working next to the real one. |
| `RotationRepliesAreLive` | An ok rotation reply carries a refresh token and a session that both work when the reply is built. | The CLI stores a dead token and the user must log in again. |
| `RepliesMatchTheirRotation` | A rotation reply goes only to the request that made the rotation: the same old token and the same `rotation_request_id`. | Anyone holding an old token gets the new one, which defeats rotation. |
| `LogoutIsFinal` | After a logout or "revoke this CLI" commits, the family has no working refresh token or linked session, and no refresh succeeds again. | A logged-out CLI keeps access. |
| `SignOutAllIsFinal` | The same, after "sign out every CLI". | A CLI the user signed out keeps access. |
| `SignOutAllEndsEveryCliSession` | "Sign out every CLI" leaves no CLI session of the user alive, including an unlinked device-login session. | A CLI session survives the button that promises to end them all. |

`TypeOK` is a sanity check on the model's counters.

## When to use

Run the check when a change touches any of these. The model describes them as of the sync commit below.

| Code | Model actions |
| --- | --- |
| `apps/web/app/services/cli-refresh-credentials.server.ts` `refreshCliSession` | `RotateRead`, `RotateBatch` |
| same file, `readRotationReplay` | `RotateReplay` |
| same file, `refreshLegacyCliSession` | `LegacyRead`, `LegacyBatch`, `LegacyCheck` |
| same file, `revokeCliRefreshCredential`, `revokeCliRefreshCredentialFamily`, `revokeCliRefreshCredentialFamilyAtomic`, `matchingFamilyQuery` | `LogoutPrecheck`, `LogoutBatch` |
| same file, `revokeAllCliRefreshCredentialFamilies`, `buildCliRefreshCredentialRevocationStatements`, `unlinkedCliSessionIds` | `SignOutAllBatch` |
| `apps/web/app/services/auth.server.ts`, the `databaseHooks.session.create.before` hook that sets `CLI_DEVICE_SESSION_USER_AGENT` | `DeviceLogin` |
| `apps/web/app/lib/d1-batch.server.ts` `runD1Batch` (one batch = one atomic step) | every `*Batch` action |

**Sync commit: `eefce1b27e8020aa9a2993b58cd7a7f636a45603`.** To see whether covered code moved since then:

```sh
git diff --stat eefce1b27e8020aa9a2993b58cd7a7f636a45603 -- apps/web/app/services/cli-refresh-credentials.server.ts apps/web/app/services/auth.server.ts apps/web/app/lib/d1-batch.server.ts
```

If a covered function changed, read the diff against the model before you trust a pass. A pass on a model that no longer matches the code proves nothing.

## Run

From the repository root:

```sh
pnpm check:cli-refresh-model
```

It needs Java 11 or later and `curl` on PATH. The runner is `scripts/lib/tlc-check.mjs`; `check.mjs` records what each check should do. The first run downloads `tla2tools.jar` v1.7.4, checks its SHA-256, and caches it in `~/.cache/artifactshare/`. A run takes about 30 seconds on 4 cores. Pass `--keep` (`node .claude/skills/verify-cli-refresh-rotation/check.mjs --keep`) to keep the TLC output folders.

The command runs three kinds of check and prints one line each:

1. **baseline**: one full exploration with every rule that should hold. Expect `ok ... pass`.
2. **known finding**: each rule in `KNOWN_FINDINGS` in `check.mjs`, which the current code breaks. Expect `ok ... violated` with the recorded path.
3. **mutation**: each entry in `MUTATIONS` is a broken copy of one guard in the code, written as a text change to the model. Expect `ok ... violated` on the rule that guards it. This shows that each rule can still fail. **scoped baseline** runs a rule in a narrower scope where its known finding cannot happen, so its mutation has a passing baseline to break.

It ends with `All checks behaved as recorded.` and exit code 0, or names each check that did not, with the path TLC found and its output file, and exits 1.

## Read a result

Read every TLC result with the pstack `/statechart` skill. Give it `model/CliRefreshRotation.tla`, the config, and `model/statechart-view.mjs` as the view. It prints the shortest path to each broken rule in plain words, and when everything holds it draws how the family moves between states. Shrink the constants in a scratch copy of the config if the chart is too busy.

Then decide whether the path is a real bug or a modeling error. Replay it against the code, one step per action, as a test in `apps/web/app/services/cli-refresh-credentials.server.test.ts`. That file runs the service on SQLite through `createD1BatchFixture`, and `sqliteRef.beforeNextBatch` runs a step of your choice right before the next batch, which is how you put a logout or another refresh between a read and its batch. The hook may be async and call the service itself:

```ts
sqliteRef.beforeNextBatch = async () => {
  sqliteRef.beforeNextBatch = null
  await revokeAllCliRefreshCredentialFamilies(db, 'u1') // SignOutAllBatch
}
const result = await refreshCliSession(db, issued.refreshToken, 'r1', secret) // RotateRead, then RotateBatch after the hook
```

If the code does what the path says, it is a real bug: report it with that test, and add it to `KNOWN_FINDINGS` only if the user decides not to fix it now. If the code does not, the model is wrong: fix the model so it matches the code. Never weaken a rule or remove a step to make a check pass.

## Update the model for an intended change

1. Find the actions that the changed functions map to in the table above.
2. Make each D1 read one action and each `runD1Batch` call one action. Inside a batch action, apply the statements in code order, and evaluate each statement's WHERE on the state the earlier statements left. Copy the guards, not a summary of them, and keep the code comment next to each guard.
3. If a guard text that a mutation targets changed, update its `find` and `replace` in `MUTATIONS`. The run refuses a mutation whose text is missing. If you add a guard that a rule depends on, add a mutation for it and confirm it breaks that rule.
4. If you add a rule, add it to the INVARIANTS in `model/CliRefreshRotation.cfg`, add a row to the rules table, and show it failing on a mutation.
5. Run `pnpm check:cli-refresh-model` until it reports `All checks behaved as recorded.`
6. Move the sync commit in this file to the commit you checked, only after you confirm that the model describes every covered function at that commit. Update the coverage table if functions were renamed or moved.

## Scope

Verified: every interleaving of 2 CLI processes, each making up to 2 refresh attempts with either of 2 `rotation_request_id` values (equal values model two processes that share a `pending_rotation_id`), plus one logout of the family, one "sign out every CLI", and one device login, for one human user and one credential family, with at most 4 credentials and 5 sessions. Old CLIs use the legacy path with no request id.

Assumed: D1 runs each `runD1Batch` call as one transaction. The SQLite test fixture runs the statements one by one without a transaction, so it does not show batch atomicity.

Left out:

- Time: credential and session expiry, the 10-minute rotation retry window, and `cleanupExpiredCliRotationReplays`.
- `issueCliRefreshCredential`, so new families and the linking of a device-login session to a family.
- Bots (stop and token reissue), the `cli_family_authorities` status, preset, and publisher identity checks, and the session authority rows.
- The admin and member-removal paths (`revokeAllCliRefreshCredentialFamiliesForMember`, team management), which reuse `buildCliRefreshCredentialRevocationStatements` with an extra guard.
- The CLI side: how `packages/cli` stores tokens and retries.

Observed, not a rule: an old CLI on the legacy path can get an ok reply that returns the family root token after a new CLI has already rotated it. The session in that reply works, but the refresh token does not. The code makes no promise about this mixed case.

## Known finding

`SignOutAllEndsEveryCliSession` breaks on this path: the user logs out of the only CLI family, a device login creates a CLI session that is not linked to a family yet (the CLI stopped before it issued a refresh credential, or an old CLI never does), and the user signs out every CLI. Every statement in the sign-out batch is guarded by `exists(activeFamilies())`, and no family is active, so the batch deletes nothing and the device-login session keeps working. The settings page shows the button only while at least one family is listed, so in the UI this needs the last family to end between page load and the click. Reproduced on the real code with a test that issues a family, revokes it with `revokeCliRefreshCredential`, inserts an unlinked `artifactshare-cli-device` session, and calls `revokeAllCliRefreshCredentialFamilies`: the session row remains.
