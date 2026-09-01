ALTER TABLE access_requests
  ADD COLUMN handler_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

UPDATE access_requests
SET handler_user_id = resolved_by_user_id
WHERE status IN ('approved', 'rejected')
  AND resolved_by_user_id IS NOT NULL;

-- Preserve the existing priority for requests already waiting at deployment:
-- human artifact owner, project creator, workspace owner, one admin, then a
-- project manager when workspace roles cannot approve.
UPDATE access_requests
SET handler_user_id = (
  SELECT s.owner_user_id
  FROM shareables s
  JOIN users owner ON owner.id = s.owner_user_id
  WHERE s.id = access_requests.shareable_id
    AND owner.kind = 'human'
    AND owner.email_verified = 1
)
WHERE status = 'pending';

UPDATE access_requests
SET handler_user_id = (
  SELECT c.created_by_id
  FROM shareables s
  JOIN artifact_containers c ON c.id = s.container_id
  JOIN users creator ON creator.id = c.created_by_id
  JOIN workspace_members member
    ON member.workspace_id = s.workspace_id
   AND member.user_id = c.created_by_id
  WHERE s.id = access_requests.shareable_id
    AND s.visibility = 'project'
    AND c.kind = 'project'
    AND c.archived_at IS NULL
    AND creator.kind = 'human'
    AND creator.email_verified = 1
    AND member.status = 'active'
)
WHERE status = 'pending'
  AND handler_user_id IS NULL;

UPDATE access_requests
SET handler_user_id = (
  SELECT member.user_id
  FROM shareables s
  JOIN workspace_members member ON member.workspace_id = s.workspace_id
  JOIN users candidate ON candidate.id = member.user_id
  WHERE s.id = access_requests.shareable_id
    AND member.role = 'owner'
    AND member.status = 'active'
    AND candidate.kind = 'human'
    AND candidate.email_verified = 1
  LIMIT 1
)
WHERE status = 'pending'
  AND handler_user_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM shareables s
    JOIN users owner ON owner.id = s.owner_user_id
    LEFT JOIN artifact_containers c ON c.id = s.container_id
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = access_requests.shareable_id
      AND (
        (
          owner.kind = 'bot'
          AND c.kind = 'inbox'
        )
        OR (
          owner.kind IN ('human', 'bot')
          AND s.visibility = 'project'
          AND c.kind = 'project'
          AND c.archived_at IS NULL
          AND w.plan = 'team'
        )
      )
  );

UPDATE access_requests
SET handler_user_id = (
  SELECT member.user_id
  FROM shareables s
  JOIN workspace_members member ON member.workspace_id = s.workspace_id
  JOIN users candidate ON candidate.id = member.user_id
  WHERE s.id = access_requests.shareable_id
    AND member.role = 'admin'
    AND member.status = 'active'
    AND candidate.kind = 'human'
    AND candidate.email_verified = 1
  ORDER BY member.created_at, member.user_id
  LIMIT 1
)
WHERE status = 'pending'
  AND handler_user_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM shareables s
    JOIN users owner ON owner.id = s.owner_user_id
    LEFT JOIN artifact_containers c ON c.id = s.container_id
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = access_requests.shareable_id
      AND (
        (
          owner.kind = 'bot'
          AND c.kind = 'inbox'
        )
        OR (
          owner.kind IN ('human', 'bot')
          AND s.visibility = 'project'
          AND c.kind = 'project'
          AND c.archived_at IS NULL
          AND w.plan = 'team'
        )
      )
  );

UPDATE access_requests
SET handler_user_id = (
  SELECT manager_user.id
  FROM shareables s
  JOIN artifact_containers c ON c.id = s.container_id
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN project_share_defaults manager_grant
    ON manager_grant.project_container_id = c.id
   AND manager_grant.role = 'manager'
  JOIN users manager_user ON lower(manager_user.email) = lower(manager_grant.email)
  WHERE s.id = access_requests.shareable_id
    AND s.visibility = 'project'
    AND c.kind = 'project'
    AND c.archived_at IS NULL
    AND w.plan <> 'free'
    AND w.external_posting_enabled = 1
    AND manager_user.kind = 'human'
    AND manager_user.email_verified = 1
  ORDER BY manager_grant.created_at, manager_grant.id
  LIMIT 1
)
WHERE status = 'pending'
  AND handler_user_id IS NULL;

CREATE INDEX access_requests_handler_pending
  ON access_requests(handler_user_id, status, created_at, id);
