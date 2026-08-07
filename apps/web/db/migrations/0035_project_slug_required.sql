-- プロジェクトは URL (/projects/<slug>) でしかアクセスできないため、slug を必須に
-- する。既存プロジェクトは 0032 で backfill 済みで、作成時も必ず付与している。
-- inbox は slug を持たないので対象外。container_id 必須 (0030) と同じトリガー方式。
CREATE TRIGGER artifact_containers_project_slug_required_insert
BEFORE INSERT ON artifact_containers
WHEN NEW.kind = 'project' AND NEW.slug IS NULL
BEGIN
  SELECT RAISE(ABORT, 'artifact_containers.slug is required for projects');
END;

CREATE TRIGGER artifact_containers_project_slug_required_update
BEFORE UPDATE OF slug ON artifact_containers
WHEN NEW.kind = 'project' AND NEW.slug IS NULL
BEGIN
  SELECT RAISE(ABORT, 'artifact_containers.slug is required for projects');
END;
