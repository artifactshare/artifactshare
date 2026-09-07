-- The new-account link publish limit starts a judgment with the
-- `publish_burst` trigger. Widen the trigger CHECK; rebuild to keep rows.
CREATE TABLE link_abuse_judgments_next (
  id                 TEXT PRIMARY KEY,
  shareable_id       TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  trigger            TEXT NOT NULL CHECK (trigger IN ('view_spike', 'ad_click', 'publish_burst', 'manual')),
  risk               TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  reason             TEXT NOT NULL,
  impersonated_brand TEXT,
  external_targets   TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

INSERT INTO link_abuse_judgments_next (
  id, shareable_id, trigger, risk, reason, impersonated_brand,
  external_targets, provider, model, created_at
)
SELECT
  id, shareable_id, trigger, risk, reason, impersonated_brand,
  external_targets, provider, model, created_at
FROM link_abuse_judgments;

DROP TABLE link_abuse_judgments;
ALTER TABLE link_abuse_judgments_next RENAME TO link_abuse_judgments;

CREATE INDEX link_abuse_judgments_shareable_created
  ON link_abuse_judgments(shareable_id, created_at DESC);
