CREATE TRIGGER access_requests_audit_created
AFTER INSERT ON access_requests
WHEN NEW.status = 'pending'
BEGIN
  INSERT INTO audit_events (
    id,
    workspace_id,
    actor_user_id,
    action,
    subject_type,
    subject_id,
    detail,
    created_at
  )
  SELECT
    'access-request-created:' || NEW.id,
    s.workspace_id,
    requester.id,
    'access_request.created',
    'access_request',
    NEW.id,
    json_object(
      'access_request_id', NEW.id,
      'artifact_id', s.id,
      'artifact_title', coalesce(s.title_override, s.derived_title, s.name),
      'project_id', CASE WHEN c.kind = 'project' THEN c.id END,
      'project_name', CASE WHEN c.kind = 'project' THEN c.name END,
      'requester_id', requester.id,
      'requester_name', requester.name,
      'requester_email', requester.email,
      'handler_id', handler.id,
      'handler_name', handler.name,
      'handler_email', handler.email,
      'actor_id', requester.id,
      'actor_name', requester.name,
      'actor_email', requester.email
    ),
    NEW.created_at
  FROM shareables s
  LEFT JOIN artifact_containers c ON c.id = s.container_id
  JOIN users requester ON requester.id = NEW.requester_user_id
  JOIN users handler ON handler.id = NEW.handler_user_id
  WHERE s.id = NEW.shareable_id;
END;

CREATE TRIGGER access_requests_audit_resolved
AFTER UPDATE OF status ON access_requests
WHEN OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
BEGIN
  INSERT INTO audit_events (
    id,
    workspace_id,
    actor_user_id,
    action,
    subject_type,
    subject_id,
    detail,
    created_at
  )
  SELECT
    'access-request-decision:' || NEW.id,
    s.workspace_id,
    actor.id,
    CASE
      WHEN NEW.status = 'approved' THEN 'access_request.approved'
      ELSE 'access_request.rejected'
    END,
    'access_request',
    NEW.id,
    json_object(
      'access_request_id', NEW.id,
      'artifact_id', s.id,
      'artifact_title', coalesce(s.title_override, s.derived_title, s.name),
      'project_id', CASE WHEN c.kind = 'project' THEN c.id END,
      'project_name', CASE WHEN c.kind = 'project' THEN c.name END,
      'requester_id', requester.id,
      'requester_name', requester.name,
      'requester_email', requester.email,
      'handler_id', handler.id,
      'handler_name', handler.name,
      'handler_email', handler.email,
      'actor_id', actor.id,
      'actor_name', actor.name,
      'actor_email', actor.email,
      'resolution_scope', NEW.resolution_scope,
      'decision_status', NEW.status
    ),
    coalesce(NEW.resolved_at, NEW.updated_at)
  FROM shareables s
  LEFT JOIN artifact_containers c ON c.id = s.container_id
  JOIN users requester ON requester.id = NEW.requester_user_id
  JOIN users handler ON handler.id = NEW.handler_user_id
  JOIN users actor ON actor.id = NEW.resolved_by_user_id
  WHERE s.id = NEW.shareable_id;
END;
