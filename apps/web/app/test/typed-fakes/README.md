# Typed test fakes

Use `cliAuthority.agent({ workspaceId })` (or unrestricted, bootstrap, publisher,
bridge), `workerEnv` for scheduled Worker dependencies, `stripeSubscription` and
`stripeClient` for billing sync, `dataTransfer` for upload expansion,
`d1Database`/`d1Statement` for the D1 adapter, and `parentWindow(page)` for the
PDF/video parent fixture controls. Each accepts partial typed overrides. Unused
D1 and bucket operations throw so unexpected calls cannot silently succeed.

Keep deliberately invalid values local to their negative test, document the
invalid shape, and do not replace them with a valid builder.
