-- Operator-only identifiers; intentionally no product foreign keys.
CREATE TABLE security_deception_signals (
  id TEXT PRIMARY KEY NOT NULL,
  decoy_id TEXT NOT NULL CHECK (decoy_id = 'credential_inventory_v1'),
  reason TEXT NOT NULL CHECK (reason = 'authenticated_decoy_probe'),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'bot')),
  actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  auth_route TEXT NOT NULL CHECK (auth_route IN ('cookie', 'api_token', 'cli_session', 'oauth')),
  client_kind TEXT CHECK (client_kind IN ('api_token', 'oauth_client', 'agent_profile', 'publisher_client')),
  client_id TEXT,
  authority_kind TEXT CHECK (authority_kind IN ('unrestricted', 'bootstrap', 'agent', 'publisher', 'bridge')),
  agent_profile_id TEXT,
  publisher_client_id TEXT,
  first_detected_at TEXT NOT NULL,
  day_bucket TEXT NOT NULL CHECK (length(day_bucket) = 10 AND day_bucket GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  hour_bucket TEXT NOT NULL CHECK (length(hour_bucket) = 13 AND substr(hour_bucket, 11, 1) = 'T' AND substr(hour_bucket, 12, 2) GLOB '[0-2][0-9]' AND substr(hour_bucket, 12, 2) <= '23' AND substr(hour_bucket, 1, 10) = day_bucket),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retry', 'delivered', 'failed', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  failure_code TEXT CHECK (failure_code IN ('configuration_missing', 'network', 'http_retry', 'http_rejected', 'attempt_limit', 'age_limit')),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  CHECK ((client_kind IS NULL) = (client_id IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  UNIQUE (actor_id, workspace_id, auth_route, decoy_id, hour_bucket)
);
CREATE INDEX security_deception_day ON security_deception_signals(day_bucket);
CREATE INDEX security_deception_due ON security_deception_signals(status, next_attempt_at, first_detected_at, id);
CREATE INDEX security_deception_cleanup ON security_deception_signals(first_detected_at, id);
CREATE TABLE security_deception_delivery_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_send_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  saturated_day TEXT,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO security_deception_delivery_control (id, next_send_at) VALUES (1, '1970-01-01T00:00:00.000Z');
