-- Link sharing opens to Free workspaces: enable the per-workspace flag for
-- existing Free workspaces so their owners can save the link visibility.
-- The column default stays 0; new workspaces get the plan default in code.

UPDATE workspaces
SET link_sharing_enabled = 1
WHERE plan = 'free';
