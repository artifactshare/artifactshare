CREATE TABLE access_requests (
  id                    TEXT PRIMARY KEY,
  shareable_id          TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  requester_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution_scope      TEXT CHECK (resolution_scope IS NULL OR resolution_scope IN ('artifact', 'project')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  resolved_at           TEXT,
  CHECK (
    (status = 'pending' AND resolved_by_user_id IS NULL AND resolution_scope IS NULL AND resolved_at IS NULL)
    OR
    (status IN ('approved', 'rejected') AND resolved_at IS NOT NULL)
  ),
  CHECK (status <> 'rejected' OR resolution_scope IS NULL),
  CHECK (status <> 'approved' OR resolution_scope IS NOT NULL)
);

CREATE UNIQUE INDEX access_requests_one_pending
  ON access_requests(shareable_id, requester_user_id)
  WHERE status = 'pending';
CREATE INDEX access_requests_requester_created
  ON access_requests(requester_user_id, created_at DESC, id DESC);
CREATE INDEX access_requests_shareable_pending
  ON access_requests(shareable_id, status, created_at, id);
