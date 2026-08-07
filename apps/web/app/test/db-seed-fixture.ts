import type { DatabaseSync } from 'node:sqlite'

export function seedWorkspace(
  db: DatabaseSync,
  createdAt = '2026-05-26T00:00:00.000Z',
) {
  db.prepare(
    `INSERT INTO workspaces (
      id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
      storage_updated_at
    ) VALUES ('ws1', 'example.com', 'Example', ?, 'free', 53687091200, 1024, ?)`,
  ).run(createdAt, createdAt)
}

export function seedUser(
  db: DatabaseSync,
  id: string,
  createdAt = '2026-05-26T00:00:00.000Z',
) {
  db.prepare(
    `INSERT INTO users (
      id, email, email_verified, name, image, created_at, updated_at,
      workspace_id, locale
    ) VALUES (?, ?, 1, ?, NULL, ?, ?, 'ws1', NULL)`,
  ).run(id, `${id}@example.com`, `User ${id}`, createdAt, createdAt)
}

export function seedSession(
  db: DatabaseSync,
  userId: string,
  token: string,
  now = '2026-06-11T00:00:00.000Z',
) {
  db.prepare(
    `INSERT INTO sessions (
      id, user_id, token, expires_at, created_at, updated_at
    ) VALUES ('sess1', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(userId, token, now, now)
}
