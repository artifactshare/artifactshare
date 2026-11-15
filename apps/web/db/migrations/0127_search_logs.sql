CREATE TABLE search_logs (
  id TEXT PRIMARY KEY,
  token_key TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  query TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  result_count INTEGER NOT NULL CHECK(result_count BETWEEN 0 AND 1000),
  count_relation TEXT NOT NULL CHECK(count_relation IN ('eq','gte')),
  tier TEXT NOT NULL CHECK(tier IN ('title','phrase','all','any')),
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  discoverable_count INTEGER NOT NULL CHECK(discoverable_count >= 0),
  search_method TEXT NOT NULL DEFAULT 'allowed' CHECK(search_method IN ('candidates','allowed')),
  active_document_count INTEGER CHECK(active_document_count >= 0),
  source TEXT NOT NULL CHECK(source IN ('screen','mcp','cli'))
);
CREATE INDEX search_logs_actor_created ON search_logs(actor_id,created_at);
CREATE INDEX search_logs_created ON search_logs(created_at);
CREATE TABLE search_opens (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES search_logs(id) ON DELETE CASCADE,
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK(rank > 0),
  opened_at TEXT NOT NULL
);
CREATE INDEX search_opens_search ON search_opens(search_id);

CREATE INDEX shareables_owner_activity ON shareables(owner_user_id, activity_at DESC, id DESC);
CREATE INDEX shareable_grants_email_time ON shareable_grants(lower(granted_email), granted_at DESC, shareable_id);
