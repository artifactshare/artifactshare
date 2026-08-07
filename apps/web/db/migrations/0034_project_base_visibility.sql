-- プロジェクトに公開範囲のベースを持たせる。
-- 'workspace' = 社内全員、'private' = 関係者のみ。
-- visibility='project' の成果物は「base の範囲 ∪ 関係者 ∪ 個別共有」に見える。
-- 既存プロジェクトは社内全員として扱い、現状の挙動を保つ。inbox では使わない。
ALTER TABLE artifact_containers
  ADD COLUMN base_visibility TEXT NOT NULL DEFAULT 'workspace'
  CHECK (base_visibility IN ('workspace', 'private'));
