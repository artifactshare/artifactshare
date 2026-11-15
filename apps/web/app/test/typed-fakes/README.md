# Typed test fakes

Use `cliAuthority.agent({ workspaceId })` (or unrestricted, bootstrap, publisher,
bridge), `workerEnv` for scheduled Worker dependencies, `stripeSubscription` and
`stripeClient` for billing sync, `dataTransfer` for upload expansion,
`d1Database`/`d1Statement` for the D1 adapter, and `parentWindow(page)` for the
PDF/video parent fixture controls. Each accepts partial typed overrides. Unused
D1 and bucket operations throw so unexpected calls cannot silently succeed.

Keep deliberately invalid values local to their negative test, document the
invalid shape, and retain its cast in the inventory. Do not replace it with a
valid builder or exempt it from the count.

The public test audit enforces per-file double-cast ceilings and parses these
builder modules to reject type assertions (including non-null assertions).
Const assertions and `satisfies` are allowed. Register any supporting builder
module in `scripts/test-cast-ratchet.mjs` too.

After removing casts, run `node scripts/test-cast-ratchet.mjs --update-baseline`
and commit the lowered `config/test-cast-baseline.json`. Updating refuses growth.
The count measures inventory, not whether a cast caused a historical failure.
