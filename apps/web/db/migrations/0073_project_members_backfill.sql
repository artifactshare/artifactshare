INSERT OR IGNORE INTO project_members (container_id, user_id, joined_at, last_seen_at)
SELECT id, created_by_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM artifact_containers
WHERE kind = 'project' AND created_by_id IS NOT NULL;
