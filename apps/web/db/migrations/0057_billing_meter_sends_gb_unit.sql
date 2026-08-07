-- Pre-flight guard. Rebuilds billing_meter_sends with GB-unit column names.
-- Safe only when no meter sends have been recorded yet; aborts if any rows exist.
-- Non-TEMP table on purpose: Cloudflare D1 rejects CREATE TEMP TABLE with SQLITE_AUTH.
DROP TABLE IF EXISTS _billing_meter_sends_guard;
CREATE TABLE _billing_meter_sends_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _billing_meter_sends_guard (ok)
  SELECT CASE WHEN (SELECT COUNT(*) FROM billing_meter_sends) = 0 THEN 1 ELSE 0 END;
DROP TABLE _billing_meter_sends_guard;

DROP TABLE billing_meter_sends;

CREATE TABLE billing_meter_sends (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month            TEXT NOT NULL,
  overage_gb_month INTEGER NOT NULL,
  sent_at          TEXT NOT NULL,
  PRIMARY KEY (workspace_id, month)
);
