-- Link expiry now starts with no maximum on every plan. Existing rows cannot
-- reveal whether a 90-day maximum came from the old column default or from an
-- explicit owner/admin choice, so this migration preserves every stored value.
-- Environments that applied an earlier revision may already have changed some
-- Free rows from 90 to NULL; their original intent is equally unrecoverable, so
-- this marker does not guess by changing them back.
SELECT 1;
