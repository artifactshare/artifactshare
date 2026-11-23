-- A removed owner still occupies the unique owner slot. Release it only
-- where the promotion below has an eligible replacement in this migration.
UPDATE workspace_members AS former
SET role = 'member'
WHERE former.role = 'owner' AND former.status = 'removed'
  AND EXISTS (
    SELECT 1 FROM users u
    LEFT JOIN workspace_members m
      ON m.user_id = u.id AND m.workspace_id = former.workspace_id
    WHERE u.kind = 'human' AND (m.status IS NULL OR m.status = 'active')
      AND (u.workspace_id = former.workspace_id OR m.role = 'admin')
  );

WITH candidates AS (
  SELECT u.workspace_id, u.id, u.created_at, m.first_contributed_at, 0 AS is_admin
  FROM users u
  LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = u.workspace_id
  WHERE u.kind = 'human' AND (m.status IS NULL OR (m.status = 'active' AND m.role = 'member'))
  UNION ALL
  SELECT m.workspace_id, u.id, u.created_at, m.first_contributed_at, 1
  FROM workspace_members m JOIN users u ON u.id = m.user_id
  WHERE u.kind = 'human' AND m.status = 'active' AND m.role = 'admin'
), tenures AS (
  SELECT c.*, CASE WHEN is_admin THEN (
    -- The latest role transition either started this tenure or ended an
    -- earlier one. In the latter case the current start is unknown.
    SELECT CASE WHEN e.action = 'admin.grant'
      OR (e.action = 'owner.transfer' AND e.actor_user_id = c.id)
      THEN e.created_at END
    FROM audit_events e
    WHERE e.workspace_id = c.workspace_id AND e.subject_type = 'user'
      AND ((e.subject_id = c.id AND e.action IN ('admin.grant', 'admin.revoke', 'owner.transfer', 'member.remove'))
        OR (e.actor_user_id = c.id AND e.action = 'owner.transfer'))
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1
  ) END AS tenure_start
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_members o WHERE o.workspace_id = c.workspace_id
      AND o.role = 'owner' AND o.status = 'active'
  )
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY workspace_id ORDER BY is_admin DESC, tenure_start ASC NULLS LAST,
      first_contributed_at ASC NULLS LAST, created_at, id
  ) AS position FROM tenures
)
INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
SELECT workspace_id, id, 'owner', 'active',
  created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM ranked WHERE position = 1
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at;
