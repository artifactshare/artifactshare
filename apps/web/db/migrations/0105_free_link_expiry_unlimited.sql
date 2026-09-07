-- Link expiry now starts with no maximum on every plan, so "no expiration" is
-- selectable without a settings change. Existing Free workspaces still on the
-- old starting maximum (90 days) move to no maximum; paid workspaces and any
-- workspace that chose another value keep their setting. Default expiry
-- (30 days) is unchanged, and a finite default is valid with no maximum.
UPDATE workspaces
SET link_expiry_max_days = NULL
WHERE plan = 'free'
  AND link_expiry_max_days = 90;
