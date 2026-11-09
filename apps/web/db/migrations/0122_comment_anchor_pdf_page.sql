-- A PDF page comment is a comment_anchors row with a page number. The row
-- keeps the posting version in version_id; its text columns hold empty
-- placeholders only because they are NOT NULL. Existing rows stay text anchors.
ALTER TABLE comment_anchors ADD COLUMN page_number INTEGER CHECK (page_number IS NULL OR (typeof(page_number) = 'integer' AND page_number BETWEEN 1 AND 100000));
