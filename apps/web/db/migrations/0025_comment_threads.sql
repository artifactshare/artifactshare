CREATE TABLE comment_threads (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_by_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolved_by_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX comment_threads_shareable_status_updated
  ON comment_threads(shareable_id, status, updated_at DESC);

CREATE TABLE comment_messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_by_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX comment_messages_thread_created
  ON comment_messages(thread_id, created_at ASC);
