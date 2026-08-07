-- shareables.visibility に 'link' を追加する。
-- 0038 で作成した書き込みトリガの許可値を更新する。
DROP TRIGGER IF EXISTS shareables_visibility_valid_insert;
DROP TRIGGER IF EXISTS shareables_visibility_valid_update;

CREATE TRIGGER shareables_visibility_valid_insert
BEFORE INSERT ON shareables
WHEN NEW.visibility NOT IN ('private', 'workspace', 'project', 'link')
BEGIN
  SELECT RAISE(ABORT, 'shareables.visibility must be private | workspace | project | link');
END;

CREATE TRIGGER shareables_visibility_valid_update
BEFORE UPDATE OF visibility ON shareables
WHEN NEW.visibility NOT IN ('private', 'workspace', 'project', 'link')
BEGIN
  SELECT RAISE(ABORT, 'shareables.visibility must be private | workspace | project | link');
END;
