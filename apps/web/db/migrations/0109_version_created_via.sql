ALTER TABLE versions ADD COLUMN created_via TEXT CHECK (created_via IN ('web', 'cli', 'mcp', 'api'));
