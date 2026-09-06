CREATE TABLE anonymous_view_signals (
  id             TEXT PRIMARY KEY,
  shareable_id   TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  viewed_at      TEXT NOT NULL,
  referrer_host  TEXT,
  ad_click_param TEXT CHECK (
    ad_click_param IS NULL OR
    ad_click_param IN ('gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'twclid')
  )
);
CREATE INDEX anonymous_view_signals_shareable_viewed
  ON anonymous_view_signals(shareable_id, viewed_at);
CREATE INDEX anonymous_view_signals_viewed
  ON anonymous_view_signals(viewed_at);

CREATE TABLE link_abuse_judgment_gates (
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('automatic', 'manual')),
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (shareable_id, kind)
);

CREATE TABLE link_abuse_judgments (
  id                 TEXT PRIMARY KEY,
  shareable_id       TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  trigger            TEXT NOT NULL CHECK (trigger IN ('view_spike', 'ad_click', 'manual')),
  risk               TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  reason             TEXT NOT NULL,
  impersonated_brand TEXT,
  external_targets   TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX link_abuse_judgments_shareable_created
  ON link_abuse_judgments(shareable_id, created_at DESC);
