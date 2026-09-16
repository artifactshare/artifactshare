import { fileURLToPath } from 'node:url'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { d1CompatibilityPlugin } from '~/lib/d1-compatibility.server'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import { listAgentReadableArtifacts } from '~/services/cli-artifacts.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let binding: D1Database
let db: Kysely<DB>

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  binding = (await worker.getEnv()).DB
  db = new Kysely<DB>({
    dialect: new D1Dialect({ database: binding }),
    plugins: [d1CompatibilityPlugin],
  })
})

afterAll(async () => {
  await db?.destroy()
  await server.close()
})

it('runs the viewer snapshot and paginated outer join on D1', async () => {
  await binding.batch([
    binding.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'One', '2026-01-01'), ('ws2', 'Two', '2026-01-01')",
    ),
    binding.prepare(
      "INSERT INTO users (id, email, email_verified, name, workspace_id, google_sub, created_at, updated_at) VALUES ('u1', 'u1@example.com', 1, 'User', 'ws1', 'agent-list-snapshot-u1', '2026-01-01', '2026-01-01')",
    ),
    binding.prepare(
      "INSERT INTO artifact_containers (id, workspace_id, kind, name, base_visibility, created_at, updated_at) VALUES ('p1', 'ws1', 'project', 'Project', 'workspace', '2026-01-01', '2026-01-01')",
    ),
    ...Array.from({ length: 51 }, (_, i) =>
      binding
        .prepare(
          "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_at, updated_at) VALUES (?, 'ws1', 'u1', 'Artifact', 'markdown_page', 'workspace', 'p1', '2026-01-01', '2026-01-01')",
        )
        .bind(`a${String(i).padStart(2, '0')}`),
    ),
  ])
  const user = { id: 'u1' } as SessionUser
  const authority = {
    kind: 'agent' as const,
    familyId: 'f1',
    workspaceId: 'ws1',
    projectId: 'p1',
    projectNameSnapshot: 'Project',
    agentProfileId: 'agent1',
  }
  const args = { baseUrl: 'https://artifactshare.test' }
  const first = await listAgentReadableArtifacts(db, user, authority, args)
  expect(first.kind).toBe('ok')
  if (first.kind !== 'ok') return
  expect(first.data.artifacts).toHaveLength(50)
  expect(first.data.artifacts[0]).toMatchObject({
    id: 'a50',
    owner_email: 'u1@example.com',
  })
  expect(first.data.has_more).toBe(true)
  const second = await listAgentReadableArtifacts(db, user, authority, {
    ...args,
    cursor: first.data.next_cursor!,
  })
  expect(second.kind).toBe('ok')
  if (second.kind !== 'ok') return
  expect(second.data.artifacts.map(({ id }) => id)).toEqual(['a00'])
  expect(second.data.has_more).toBe(false)
  expect(second.data.next_cursor).toBeNull()
  expect(
    await listAgentReadableArtifacts(db, user, authority, {
      ...args,
      query: 'absent',
    }),
  ).toMatchObject({
    kind: 'ok',
    data: { artifacts: [], has_more: false, next_cursor: null },
  })
  expect(
    await listAgentReadableArtifacts(db, user, authority, {
      ...args,
      cursor: 'broken',
    }),
  ).toEqual({ kind: 'invalid-cursor' })
  await binding
    .prepare("UPDATE users SET workspace_id = 'ws2' WHERE id = 'u1'")
    .run()
  expect(
    await listAgentReadableArtifacts(db, user, authority, {
      ...args,
      cursor: 'broken',
    }),
  ).toEqual({ kind: 'invalid-project' })
  expect(
    await listAgentReadableArtifacts(
      db,
      { ...user, id: 'missing' },
      authority,
      { ...args, cursor: 'broken' },
    ),
  ).toEqual({ kind: 'missing-viewer' })
})
