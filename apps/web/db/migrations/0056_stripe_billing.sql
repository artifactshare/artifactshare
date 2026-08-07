ALTER TABLE workspaces ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE workspaces ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE workspaces ADD COLUMN stripe_subscription_status TEXT NOT NULL DEFAULT 'none';
CREATE UNIQUE INDEX workspaces_stripe_customer_id ON workspaces(stripe_customer_id);
CREATE UNIQUE INDEX workspaces_stripe_subscription_id ON workspaces(stripe_subscription_id);

CREATE TABLE billing_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  processed_at    TEXT,
  error           TEXT
);

CREATE TABLE workspace_storage_daily_usage (
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,
  used_bytes          INTEGER NOT NULL,
  included_bytes      INTEGER NOT NULL,
  billable_overage_gb REAL NOT NULL,
  PRIMARY KEY (workspace_id, date)
);

CREATE TABLE billing_meter_sends (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month                  TEXT NOT NULL,
  overage_milli_gb_month INTEGER NOT NULL,
  sent_at                TEXT NOT NULL,
  PRIMARY KEY (workspace_id, month)
);

UPDATE workspaces SET storage_quota_bytes = 107374182400 WHERE plan = 'team';
