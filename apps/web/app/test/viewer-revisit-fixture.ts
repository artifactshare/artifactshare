import { createMigratedInMemoryDb } from './sqlite-fixture'

const before = '2026-01-01T00:00:00.000Z'
const boundary = '2026-01-02T00:00:00.000Z'

export function createViewerRevisitFixture(
  shareableId: 's1' | 'html123abc' = 's1',
) {
  const fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Example', '${before}');
    INSERT INTO users (id, email, email_verified, created_at, updated_at, workspace_id)
      VALUES ('u1', 'owner@example.com', 1, '${before}', '${before}', 'ws1'),
             ('u2', 'reader@example.com', 1, '${before}', '${before}', 'ws1');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
      VALUES ('inbox-u1', 'ws1', 'inbox', 'u1', 'u1', 'Files', '${before}', '${before}');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_at, updated_at)
      VALUES ('${shareableId}', 'ws1', 'u1', 'Example', 'html_page', 'private', 'inbox-u1', '${before}', '${before}'),
             ('s2', 'ws1', 'u1', 'Other', 'html_page', 'private', 'inbox-u1', '${before}', '${before}');
    INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES ('v1', '${shareableId}', 'html_page', 'published', '/index.html', 'test/v1', 1, 'test', 'u2', '${before}', '${before}');
    INSERT INTO shareable_viewer_recency (shareable_id, viewer_user_id, first_viewed_at, last_viewed_at, version_seen_through_at, comment_seen_through_at)
      VALUES ('${shareableId}', 'u1', '${before}', '${boundary}', '${boundary}', '${boundary}');
  `)
  return fixture
}
