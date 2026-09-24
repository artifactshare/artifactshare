ALTER TABLE versions ADD COLUMN label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 80);
