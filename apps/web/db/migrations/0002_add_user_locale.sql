-- Migration: 0002_add_user_locale
-- Created: 2026-05-10
-- Description: Add `locale` column to users for i18n preference.
-- BCP 47 codes (e.g. 'ja', 'en-US'). NULL means "derive from
-- Accept-Language at request time".

ALTER TABLE users ADD COLUMN locale TEXT;
