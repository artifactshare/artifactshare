-- プロジェクト URL を id (/projects/:id) で解決するため、slug を廃止する。
-- 0035 のトリガー → 0032 の一意 index → 列 の順で落とす (SQLite は index で
-- 使う列を drop できないため)。shareables.slug は別物なので触らない。
DROP TRIGGER IF EXISTS artifact_containers_project_slug_required_insert;
DROP TRIGGER IF EXISTS artifact_containers_project_slug_required_update;

DROP INDEX IF EXISTS artifact_containers_workspace_slug;

ALTER TABLE artifact_containers DROP COLUMN slug;
