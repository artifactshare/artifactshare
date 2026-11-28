-- stripe_sync_token: syncWorkspaceSubscription writes only when the row is
-- still at the token it read before it asked Stripe, so a sync that read
-- Stripe earlier cannot overwrite one that read it later.
ALTER TABLE workspaces ADD COLUMN stripe_sync_token TEXT;
-- A short lease that lets one request at a time open a Stripe Checkout for the
-- workspace, so two Upgrade presses cannot open two Checkout pages.
ALTER TABLE workspaces ADD COLUMN checkout_lease_token TEXT;
ALTER TABLE workspaces ADD COLUMN checkout_lease_expires_at TEXT;
