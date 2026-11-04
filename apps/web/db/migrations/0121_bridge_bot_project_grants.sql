-- Existing private conversation mappings predate explicit bot placement grants.
-- Preserve every existing role, including viewer, and normalize new grant emails.
INSERT INTO project_share_defaults (
  id, project_container_id, email, role, created_by_id, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), project.id, lower(bot.email), 'contributor',
       bot.id, mapping.updated_at, mapping.updated_at
FROM bridge_conversations AS mapping
JOIN artifact_containers AS project ON project.id = mapping.project_id
JOIN bridge_authorities AS authority ON authority.id = mapping.bridge_authority_id
JOIN users AS bot ON bot.id = authority.bot_user_id
WHERE mapping.privacy_ceiling = 'private'
  AND project.base_visibility = 'private'
  AND bot.bot_stopped_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_share_defaults AS existing
    WHERE existing.project_container_id = project.id
      AND lower(existing.email) = lower(bot.email)
  )
ON CONFLICT (project_container_id, email) DO NOTHING;
