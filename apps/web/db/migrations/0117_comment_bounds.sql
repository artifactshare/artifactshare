-- Backfill once; subsequent reads use the trigger-maintained stored count.
ALTER TABLE comment_threads ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0);
UPDATE comment_threads SET message_count = (
  SELECT count(*) FROM comment_messages WHERE thread_id = comment_threads.id
);

CREATE INDEX comment_messages_thread_tuple ON comment_messages(thread_id, created_at, id);

CREATE TRIGGER comment_message_capacity BEFORE INSERT ON comment_messages
BEGIN
  SELECT RAISE(ABORT, 'comment_thread_closed')
    WHERE (SELECT status FROM comment_threads WHERE id = NEW.thread_id) <> 'open';
  SELECT RAISE(ABORT, 'comment_thread_capacity')
    WHERE (SELECT message_count FROM comment_threads WHERE id = NEW.thread_id) >= 500;
END;

CREATE TRIGGER comment_message_insert_count AFTER INSERT ON comment_messages
BEGIN
  UPDATE comment_threads SET message_count = message_count + 1 WHERE id = NEW.thread_id;
END;

CREATE TRIGGER comment_message_delete_count AFTER DELETE ON comment_messages
BEGIN
  UPDATE comment_threads SET message_count = message_count - 1 WHERE id = OLD.thread_id;
END;

CREATE TABLE comment_post_windows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  minute_start INTEGER NOT NULL,
  admissions INTEGER NOT NULL CHECK (admissions BETWEEN 1 AND 20),
  PRIMARY KEY (user_id, shareable_id)
);
CREATE INDEX comment_post_windows_shareable ON comment_post_windows(shareable_id);
