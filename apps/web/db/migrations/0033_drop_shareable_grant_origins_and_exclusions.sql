-- プロジェクトの関係者をアップロード時にコピーする仕組みを、継承
-- (visibility = 'project') とその場評価へ置き換えた。コピーの出所と除外を
-- 記録していた 2 テーブルは不要になったので廃止する。
-- 既存の shareables.visibility と shareable_grants は変えない (見える範囲を保つ)。
DROP TABLE IF EXISTS shareable_grant_origins;
DROP TABLE IF EXISTS shareable_project_share_default_exclusions;
