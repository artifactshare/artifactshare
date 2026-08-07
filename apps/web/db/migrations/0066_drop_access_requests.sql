-- Migration: 0066_drop_access_requests
-- Created: 2026-07-15
-- Description: Contract migration dropping access_requests after the closed-beta
-- waitlist was removed. Upload access is decided by the Flagship upload-allowed
-- flag alone; no application code references remain.
-- Mirrors db/schema.sql; keep both in sync.

DROP TABLE IF EXISTS access_requests;
