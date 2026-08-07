DROP INDEX workspace_members_single_admin;

UPDATE workspace_members
SET role = 'owner'
WHERE role = 'admin'
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_members AS existing_owner
    WHERE existing_owner.workspace_id = workspace_members.workspace_id
      AND existing_owner.role = 'owner'
  );
