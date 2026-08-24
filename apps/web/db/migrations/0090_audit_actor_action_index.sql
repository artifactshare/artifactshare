CREATE INDEX audit_events_workspace_actor_action_created
  ON audit_events(workspace_id, actor_user_id, action, created_at DESC, id DESC);
