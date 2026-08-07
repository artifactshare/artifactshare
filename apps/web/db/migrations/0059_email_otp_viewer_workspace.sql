-- Viewer-only workspaces for new email OTP signups: no self-upload and no Free quota.
-- Existing rows keep self-upload enabled via DEFAULT.

ALTER TABLE workspaces ADD COLUMN self_upload_enabled INTEGER NOT NULL DEFAULT 1;
