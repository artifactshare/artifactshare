-- 閲覧時点のタイトルと所有者名を残し、権限喪失後の改名が履歴に漏れないようにする。
--
-- 既存行は backfill しない。可視の行は表示も検索も現在値を使うためスナップショットを
-- 参照せず、次の閲覧で recordView が埋める。一方、すでに権限を失っている行へ現在値を
-- 入れることは、この migration が塞ごうとしている漏れ (失効後の改名が見える) を恒久化
-- する。埋めて良い行と埋めるべき行が重ならないので、backfill しないのが正しい。
ALTER TABLE shareable_viewer_recency ADD COLUMN viewed_title TEXT;
ALTER TABLE shareable_viewer_recency ADD COLUMN viewed_owner_name TEXT;
