-- v1.1 で `<id>.sandbox.artifactshare.com` の subdomain 配信を始めるため、
-- shareables.id を DNS-safe alphabet (`0123456789abcdefghijklmnopqrstuvwxyz-`、
-- RFC 1123) で生成するよう app layer を切り替える。既存の id は nanoid default
-- alphabet (大文字 / `_` を含む) で発行されており subdomain として無効なので、
-- 全 shareable 行を wipe する (solo 期前提)。
--
-- D1 は per-connection で foreign_keys PRAGMA がオフのまま動くことがあり、
-- ON DELETE CASCADE chain に頼らず依存テーブルを葉から明示的に DELETE する。
DELETE FROM views;
DELETE FROM views_anon;
DELETE FROM shareable_grants;
DELETE FROM versions;
DELETE FROM shareables;

-- shareables wipe で R2 オブジェクトが論理的に消失するため、users の利用量
-- カウンタもゼロに戻す。残したままだと次回 upload の quota チェックで通らない。
-- (reconcile 経路でも将来補正されるが、migration 直後〜reconcile 実行前の窓を作らない)
UPDATE users SET storage_used_bytes = 0;
