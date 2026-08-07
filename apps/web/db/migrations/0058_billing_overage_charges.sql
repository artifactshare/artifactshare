-- Replaces billing_meter_sends with billing_overage_charges for pending invoice item idempotency.
-- Existing meter send rows are copied as completed charges so already-billed months are not re-charged.

CREATE TABLE billing_overage_charges (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month                  TEXT NOT NULL,           -- 'YYYY-MM' (UTC)
  overage_gb_month       INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  stripe_invoice_item_id TEXT,
  stripe_invoice_id      TEXT,
  created_at             TEXT NOT NULL,
  processed_at           TEXT,
  PRIMARY KEY (workspace_id, month)
);

INSERT INTO billing_overage_charges (
  workspace_id,
  month,
  overage_gb_month,
  status,
  stripe_invoice_item_id,
  stripe_invoice_id,
  created_at,
  processed_at
)
SELECT
  workspace_id,
  month,
  overage_gb_month,
  'completed',
  NULL,
  NULL,
  sent_at,
  sent_at
FROM billing_meter_sends;

DROP TABLE billing_meter_sends;
