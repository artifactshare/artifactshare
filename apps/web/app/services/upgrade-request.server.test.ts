import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { buildUpgradeRequest } from './upgrade-request.server'

describe('buildUpgradeRequest', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof createMigratedInMemoryDb>['db']

  beforeEach(() => {
    ;({ sqlite, db } = createMigratedInMemoryDb())
    seedWorkspace(sqlite, 'ws1')
    seedUser(sqlite, 'owner', 'owner@example.com', 'human', 'owner')
    seedUser(sqlite, 'member', 'member@example.com', 'human', 'member')
    seedUser(sqlite, 'bot', 'bot@example.com', 'bot', 'member')
  })

  afterEach(async () => db.destroy())

  test('gives a billing action to the workspace owner', async () => {
    await expect(build('owner', 'human')).resolves.toMatchObject({
      kind: 'billing',
      limit_type: 'projects',
      current_plan: 'free',
      recommended_plan: 'plus',
      upgrade_url:
        'https://app.example.com/settings/billing?plan=plus&reason=project_limit',
    })
  })

  test('gives a copyable owner request to a member or bot', async () => {
    for (const [id, kind] of [
      ['member', 'human'],
      ['bot', 'bot'],
    ] as const) {
      await expect(build(id, kind)).resolves.toMatchObject({
        kind: 'contact',
        owner: { name: 'Owner', email: 'owner@example.com' },
        request_message: expect.stringContaining('owner@example.com'),
      })
    }
  })

  test('suppresses enrichment across a workspace boundary', async () => {
    await expect(
      buildUpgradeRequest({
        db,
        actor: { id: 'member', workspaceId: 'ws1', kind: 'human' },
        billingWorkspaceId: 'other',
        limitType: 'storage',
        observedPlan: 'free',
        locale: 'en',
        appBaseUrl: 'https://app.example.com',
      }),
    ).resolves.toBeNull()
  })

  test('percent-encodes spaces in the support mail subject', async () => {
    sqlite
      .prepare(
        `UPDATE workspace_members SET status = 'removed' WHERE workspace_id = 'ws1' AND user_id = 'owner'`,
      )
      .run()
    await expect(build('bot', 'bot')).resolves.toMatchObject({
      kind: 'support',
      support_url:
        'mailto:support@artifactshare.com?subject=Artifact%20Share%20upgrade%20help%3A%20projects',
    })
  })

  test('falls back to support when the billing origin is unsafe', async () => {
    await expect(
      buildUpgradeRequest({
        db,
        actor: { id: 'owner', workspaceId: 'ws1', kind: 'human' },
        billingWorkspaceId: 'ws1',
        limitType: 'storage',
        observedPlan: 'free',
        locale: 'en',
        appBaseUrl: 'http://127.0.0.1:8787',
      }),
    ).resolves.toMatchObject({ kind: 'support' })
  })

  function build(id: string, kind: 'human' | 'bot') {
    return buildUpgradeRequest({
      db,
      actor: { id, workspaceId: 'ws1', kind },
      billingWorkspaceId: 'ws1',
      limitType: 'projects',
      observedPlan: 'free',
      locale: 'en',
      appBaseUrl: 'https://app.example.com',
    })
  }
})

function seedWorkspace(sqlite: DatabaseSync, id: string) {
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at)
       VALUES (?, 'Example', ?, 'free', 100, 100, ?)`,
    )
    .run(id, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
}

function seedUser(
  sqlite: DatabaseSync,
  id: string,
  email: string,
  kind: 'human' | 'bot',
  role: 'owner' | 'member',
) {
  const now = '2026-08-14T00:00:00.000Z'
  sqlite
    .prepare(
      `INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id, locale, kind)
       VALUES (?, ?, 1, ?, ?, ?, 'ws1', 'en', ?)`,
    )
    .run(id, email, id === 'owner' ? 'Owner' : id, now, now, kind)
  sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
       VALUES ('ws1', ?, ?, 'active', ?, ?)`,
    )
    .run(id, role, now, now)
}
