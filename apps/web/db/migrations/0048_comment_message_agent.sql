ALTER TABLE comment_messages ADD COLUMN agent TEXT CHECK(agent IS NULL OR length(agent) <= 30);
