-- shareables.visibility はコード上では private | workspace | project のいずれかだ
-- が、列に CHECK 制約が無いため過去に enum 外の値（'public'）が混入した。中心テー
-- ブルなので物理 CHECK は親テーブル再構築が要る。container_id と同じトリガ方式で、
-- 想定外の値を書き込み時に弾く。link 共有範囲などを足すときはこのトリガも更新する。
CREATE TRIGGER shareables_visibility_valid_insert
BEFORE INSERT ON shareables
WHEN NEW.visibility NOT IN ('private', 'workspace', 'project')
BEGIN
  SELECT RAISE(ABORT, 'shareables.visibility must be private | workspace | project');
END;

CREATE TRIGGER shareables_visibility_valid_update
BEFORE UPDATE OF visibility ON shareables
WHEN NEW.visibility NOT IN ('private', 'workspace', 'project')
BEGIN
  SELECT RAISE(ABORT, 'shareables.visibility must be private | workspace | project');
END;
