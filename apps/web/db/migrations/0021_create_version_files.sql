-- version_files テーブルを R2 backed の新スキーマで作成する。0019 で旧 Drive 版を
-- DROP したあと、static-site-bundle v1.1 で multi-file 配信のために再導入。
-- path は `/` 始まり ( /index.html / /assets/app.js )、r2_key は
-- `<workspaceId>/<shareableId>/<versionId>/<path 先頭 / 除去>` のフル key を入れる。
-- scan_flags は `{"warnings":[...]}` 形式の JSON (spec §scan_flags の形式)。
CREATE TABLE version_files (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  scan_flags  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (version_id, path)
);
CREATE INDEX version_files_version_id ON version_files(version_id);
