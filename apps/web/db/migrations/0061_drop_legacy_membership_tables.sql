-- Migration: 0061_drop_legacy_membership_tables
-- Created: 2026-07-12
-- Description: Contract migration dropping workspace_admins, workspace_contributors,
-- and shareable_delete_events after 0060 backfill and application cutover to
-- workspace_members / audit_events. No application code references remain.
-- Mirrors db/schema.sql; keep both in sync.

DROP TABLE IF EXISTS shareable_delete_events;
DROP TABLE IF EXISTS workspace_contributors;
DROP TABLE IF EXISTS workspace_admins;
