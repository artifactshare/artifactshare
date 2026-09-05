import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'

const storageMock = vi.hoisted(() => ({
  putArtifact: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  deleteArtifactsByPrefix: vi.fn(),
  headArtifact: vi.fn(),
  artifactR2Key: vi.fn(
    (args: { shareableId: string; versionId: string; renderType: string }) =>
      `artifacts/${args.shareableId}/${args.versionId}/index.${args.renderType}`,
  ),
  artifactContentType: vi.fn((rt: string) =>
    rt === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
  ),
}))

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {},
    // Non-production + no FLAGS binding → checkUploadPermission allows uploads.
    APP_ENV: 'development',
    BETTER_AUTH_SECRET: 'test-secret',
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({ sql, params }),
      }),
      batch: async (stmts: Array<{ sql: string; params: unknown[] }>) => {
        const sqlite = sqliteRef.current
        if (!sqlite) throw new Error('sqlite not bound in test')
        sqlite.exec('BEGIN')
        try {
          for (const stmt of stmts) {
            sqlite.prepare(stmt.sql).run(...(stmt.params as never[]))
          }
          sqlite.exec('COMMIT')
        } catch (err) {
          sqlite.exec('ROLLBACK')
          throw err
        }
      },
    },
  },
}))

vi.mock('~/services/storage.server', () => storageMock)

import { defaultVisibilityFor, type ArtifactKind } from '~/lib/shareable-types'
import { isOrgWorkspace } from '~/lib/user'
import {
  createVersion,
  getOwnedShareableSummary,
  listOwnedShareables,
  uploadShareable,
} from '~/services/shareables.server'
import {
  createCommentThread,
  loadCommentAccess,
  setCommentThreadResolved,
} from '~/services/comments.server'
import { createProjectContainer } from '~/services/projects.server'
import type { ProjectBaseVisibility } from '~/lib/shareable-types'
import type { CommentThreadView } from '~/lib/comments'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  loadMcpUser,
  mcpUserAsSessionUser,
  type RateLimiter,
} from './identity.server'
import { createMcpServer } from './server.server'
import {
  buildArtifactFile,
  capSource,
  inferFormat,
  projectScopeLabel,
  publishContentHash,
  scopeLabel,
  singleFileFormat,
  toMcpCommentThread,
  uploadOptionsForSlackNotify,
} from './tools.server'

async function createTestProject(
  db: Parameters<typeof createProjectContainer>[0],
  workspaceId: string,
  createdById: string,
  input: {
    name: string
    description: string | null
    baseVisibility: ProjectBaseVisibility
  },
): Promise<string> {
  const result = await createProjectContainer(
    db,
    workspaceId,
    createdById,
    input,
  )
  if (result.kind !== 'ok') {
    throw new Error(`expected project creation ok, got ${result.kind}`)
  }
  return result.id
}

async function callMcp(
  db: Kysely<DB>,
  method: string,
  params: Record<string, unknown> = {},
  rateLimiters: {
    perUser: RateLimiter | null
    perWorkspace: RateLimiter | null
  } = { perUser: null, perWorkspace: null },
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const server = createMcpServer({
    identity: {
      userId: 'owner-1',
      clientId: 'client-1',
      scopes: ['openid'],
      mode: 'oauth',
    },
    db,
    executionContext: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    baseUrl: 'https://artifactshare.com',
    rateLimiters,
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  const response = await transport.handleRequest(
    new Request('https://artifactshare.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    }),
  )
  const body = (await response.json()) as {
    result?: Record<string, unknown>
    error?: unknown
  }
  return body
}

// Drive a single stateless JSON-RPC call through the real MCP server + transport
// so the SDK validates our structuredContent against each tool's outputSchema —
// the one check that only runs end-to-end, not in the helper unit tests.
async function callTool(
  db: Kysely<DB>,
  name: string,
  args: Record<string, unknown> = {},
  rateLimiters: {
    perUser: RateLimiter | null
    perWorkspace: RateLimiter | null
  } = { perUser: null, perWorkspace: null },
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  return callMcp(db, 'tools/call', { name, arguments: args }, rateLimiters)
}

describe('inferFormat', () => {
  test('detects HTML from a document or executable signal', () => {
    expect(inferFormat('<!DOCTYPE html><html></html>')).toBe('html')
    expect(inferFormat('  <html><body>hi</body></html>')).toBe('html')
    expect(inferFormat('<div id="app"></div><script>run()</script>')).toBe(
      'html',
    )
  })

  test('keeps Markdown that embeds raw HTML as markdown', () => {
    expect(inferFormat('# Title\n\n<img src="chart.png">\n\n| a | b |')).toBe(
      'markdown',
    )
    expect(inferFormat('Text with a <a href="x">link</a> inline.')).toBe(
      'markdown',
    )
    expect(inferFormat('<div class="note">just a fragment</div>')).toBe(
      'markdown',
    )
  })

  test('treats prose without tags as markdown', () => {
    expect(inferFormat('# Heading\n\nSome **bold** text.')).toBe('markdown')
  })

  test('an explicit format wins over inference', () => {
    expect(inferFormat('# looks like markdown', 'html')).toBe('html')
    expect(inferFormat('<html></html>', 'markdown')).toBe('markdown')
  })
})

describe('buildArtifactFile', () => {
  test('html gets an .html name and text/html type', () => {
    const file = buildArtifactFile('<p>hi</p>', 'html')
    expect(file.name).toBe('artifact.html')
    expect(file.type).toContain('text/html')
  })

  test('markdown gets an .md name and text/markdown type', () => {
    const file = buildArtifactFile('# hi', 'markdown')
    expect(file.name).toBe('artifact.md')
    expect(file.type).toContain('text/markdown')
  })
})

describe('scopeLabel', () => {
  test('uses the i18n catalog for the given locale', () => {
    expect(scopeLabel('workspace', 'ja')).toBe('社内全員')
    expect(scopeLabel('private', 'ja')).toBe('個別共有')
    expect(scopeLabel('project', 'ja')).toBe('プロジェクト')
    expect(scopeLabel('workspace', 'en')).toBe('Company')
    expect(scopeLabel('private', 'en')).toBe('Specific')
  })

  test('falls back to the default locale for null / unsupported locales', () => {
    expect(scopeLabel('workspace', null)).toBe('Company')
    expect(scopeLabel('workspace', 'en-US')).toBe('Company')
  })

  test('returns the raw value for an unknown visibility instead of throwing', () => {
    // The column has no CHECK constraint; a legacy value like 'public' must not
    // crash the caller (this was the real list_artifacts failure).
    expect(scopeLabel('public', 'ja')).toBe('public')
  })
})

describe('projectScopeLabel', () => {
  test('labels each base visibility from the i18n catalog', () => {
    expect(projectScopeLabel('workspace', 'ja')).toBe('社内全員')
    expect(projectScopeLabel('private', 'ja')).toBe('関係者のみ')
    expect(projectScopeLabel('workspace', 'en')).toBe(
      'Everyone in this workspace',
    )
    expect(projectScopeLabel('private', 'en')).toBe('Project members only')
  })

  test('falls back to the default locale for null / unsupported locales', () => {
    expect(projectScopeLabel('workspace', null)).toBe(
      'Everyone in this workspace',
    )
    expect(projectScopeLabel('private', 'en-US')).toBe('Project members only')
  })
})

describe('publishContentHash', () => {
  test('passes slackNotify=false to uploadShareable options', () => {
    expect(uploadOptionsForSlackNotify(false)).toEqual({ slackNotify: false })
  })
  test('is stable regardless of grant-email order', async () => {
    const base = {
      format: 'html' as const,
      visibility: 'private' as const,
      title: 'T' as string | undefined,
      content: '<p>x</p>',
      containerId: null as string | null,
    }
    const h1 = await publishContentHash({
      ...base,
      grantEmails: ['a@x.com', 'b@x.com'],
    })
    const h2 = await publishContentHash({
      ...base,
      grantEmails: ['b@x.com', 'a@x.com'],
    })
    expect(h1).toBe(h2)
  })

  test('changes when the content changes', async () => {
    const base = {
      format: 'markdown' as const,
      visibility: 'workspace' as const,
      grantEmails: [] as string[],
      title: undefined as string | undefined,
      containerId: null as string | null,
    }
    const h1 = await publishContentHash({ ...base, content: 'one' })
    const h2 = await publishContentHash({ ...base, content: 'two' })
    expect(h1).not.toBe(h2)
  })

  test('changes when the destination project changes', async () => {
    // The same content posted to two different projects must be two artifacts,
    // not an idempotent resend — so the destination is part of the key.
    const base = {
      format: 'markdown' as const,
      visibility: 'project' as const,
      grantEmails: [] as string[],
      title: undefined as string | undefined,
      content: '# same body',
    }
    const inbox = await publishContentHash({ ...base, containerId: null })
    const projA = await publishContentHash({ ...base, containerId: 'proj-a' })
    const projB = await publishContentHash({ ...base, containerId: 'proj-b' })
    expect(new Set([inbox, projA, projB]).size).toBe(3)
  })

  test('does not change when Slack notification preference changes', async () => {
    const base = {
      format: 'html' as const,
      visibility: 'workspace' as const,
      grantEmails: [] as string[],
      title: undefined as string | undefined,
      content: '<p>same</p>',
      containerId: 'proj-a',
    }
    const withPreference = (slackNotify: boolean) =>
      publishContentHash({
        ...base,
        slackNotify,
      } as Parameters<typeof publishContentHash>[0])
    const enabled = await withPreference(true)
    const disabled = await withPreference(false)
    expect(disabled).toBe(enabled)
  })
})

describe('singleFileFormat', () => {
  test('maps single-file kinds to the publish/update format vocabulary', () => {
    expect(singleFileFormat('markdown_page')).toBe('markdown')
    expect(singleFileFormat('html_page')).toBe('html')
  })

  test('returns null for multi-file bundle kinds', () => {
    expect(singleFileFormat('static_site')).toBeNull()
    expect(singleFileFormat('spa')).toBeNull()
    expect(singleFileFormat('workspace_app')).toBeNull()
  })
})

describe('capSource', () => {
  test('passes a body within the cap through untruncated', () => {
    expect(capSource('# short doc')).toEqual({
      content: '# short doc',
      truncated: false,
      nextOffset: null,
    })
  })

  test('truncates and flags a body over the cap', () => {
    const result = capSource('a'.repeat(200_001))
    expect(result.truncated).toBe(true)
    expect(result.content).toHaveLength(200_000)
    expect(result.nextOffset).toBe(200_000)
  })

  test('reads the remainder from next_offset and finishes untruncated', () => {
    const body = 'a'.repeat(200_001)
    const first = capSource(body)
    expect(first.nextOffset).toBe(200_000)
    const rest = capSource(body, first.nextOffset ?? 0)
    expect(rest.content).toBe('a')
    expect(rest.truncated).toBe(false)
    expect(rest.nextOffset).toBeNull()
  })

  test('an offset past the end returns empty and untruncated', () => {
    expect(capSource('abc', 99)).toEqual({
      content: '',
      truncated: false,
      nextOffset: null,
    })
  })

  test('does not leave a split surrogate pair at the cut boundary', () => {
    // '😀' is a surrogate pair; with 199_999 leading chars its high surrogate
    // lands at index 199_999, exactly the cut. It must be dropped, not kept lone.
    const { content, truncated, nextOffset } = capSource(
      `${'a'.repeat(199_999)}😀b`,
    )
    expect(truncated).toBe(true)
    expect(content).toHaveLength(199_999)
    const lastUnit = content.charCodeAt(content.length - 1)
    expect(lastUnit < 0xd800 || lastUnit > 0xdfff).toBe(true)
    // next_offset points at the dropped high surrogate, so continuing from it
    // re-reads the whole pair rather than skipping it.
    expect(nextOffset).toBe(199_999)
    const rest = capSource(`${'a'.repeat(199_999)}😀b`, nextOffset ?? 0)
    expect(rest.content).toBe('😀b')
  })
})

describe('toMcpCommentThread', () => {
  const baseThread: CommentThreadView = {
    id: 't1',
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    resolvedAt: null,
    canResolve: true,
    messages: [
      {
        id: 'm1',
        body: 'Looks good',
        agent: null,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        author: {
          id: 'u1',
          name: 'Alice',
          email: 'alice@example.com',
          image: 'https://img.example/a.png',
        },
        canEdit: true,
        canDelete: true,
      },
    ],
  }

  test('maps an artifact-level thread and keeps only agent-relevant fields', () => {
    const mapped = toMcpCommentThread(baseThread)
    expect(mapped.anchor).toEqual({
      kind: 'artifact',
      quoted_text: null,
      state: null,
    })
    expect(mapped.messages[0]).toEqual({
      message_id: 'm1',
      author_name: 'Alice',
      author_email: 'alice@example.com',
      agent: null,
      body: 'Looks good',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    })
    // The viewer's UI-only permission flags and avatar image stay out of the payload.
    expect(mapped).not.toHaveProperty('canResolve')
    expect(mapped.messages[0]).not.toHaveProperty('canEdit')
    expect(mapped.messages[0]).not.toHaveProperty('canDelete')
    expect(mapped.messages[0]).not.toHaveProperty('author_image')
  })

  // Only kind / state / quotedText reach the MCP payload; the rest of a text
  // subject (offsets, css path, context) is anchor-resolution detail the tool
  // drops, so default it and let each test override just what it asserts.
  function textSubject(
    override: Partial<Extract<CommentThreadView['subject'], { kind: 'text' }>>,
  ): CommentThreadView['subject'] {
    return {
      kind: 'text',
      state: 'attached',
      quotedText: 'the second paragraph',
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: 'v1',
      textStart: 10,
      textEnd: 30,
      cssPath: null,
      ...override,
    }
  }

  test('maps a text anchor with its quote and attachment state', () => {
    const mapped = toMcpCommentThread({
      ...baseThread,
      id: 't2',
      status: 'resolved',
      resolvedAt: '2026-05-03T00:00:00.000Z',
      subject: textSubject({}),
    })
    expect(mapped.status).toBe('resolved')
    expect(mapped.resolved_at).toBe('2026-05-03T00:00:00.000Z')
    expect(mapped.anchor).toEqual({
      kind: 'text',
      quoted_text: 'the second paragraph',
      state: 'attached',
    })
  })

  test('marks an orphaned anchor so the agent knows the quote no longer matches', () => {
    const mapped = toMcpCommentThread({
      ...baseThread,
      subject: textSubject({
        state: 'orphaned',
        quotedText: 'a span a later edit removed',
      }),
    })
    expect(mapped.anchor.state).toBe('orphaned')
  })
})

// ── headless wiring against the real schema ──────────────────────

const NOW = '2026-05-22T00:00:00.000Z'

async function seedWorkspace(
  db: Kysely<DB>,
  args: { id: string; hd: string | null; plan?: string },
) {
  await db
    .insertInto('workspaces')
    .values({
      id: args.id,
      hd: args.hd,
      name: args.hd ?? 'Personal',
      created_at: NOW,
      plan: args.plan ?? 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: NOW,
    })
    .execute()
}

async function seedUser(
  db: Kysely<DB>,
  args: {
    id: string
    workspaceId: string
    email?: string
    name?: string
    locale?: string | null
  },
) {
  await db
    .insertInto('users')
    .values({
      id: args.id,
      email: args.email ?? `${args.id}@example.com`,
      email_verified: 1,
      name: args.name ?? args.id,
      image: null,
      created_at: NOW,
      updated_at: NOW,
      workspace_id: args.workspaceId,
      locale: args.locale ?? null,
    })
    .execute()
}

describe('headless publish wiring', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createD1BatchFixture({ sqlite: sqliteRef })
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.getArtifact.mockReset()
    await seedWorkspace(db, { id: 'ws-a', hd: 'example.com' })
    await seedUser(db, { id: 'owner-1', workspaceId: 'ws-a', name: 'Owner' })
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('loadMcpUser joins the workspace identity the tools need', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    expect(user).toEqual({
      id: 'owner-1',
      email: 'owner-1@example.com',
      emailVerified: true,
      name: 'Owner',
      workspaceId: 'ws-a',
      hd: 'example.com',
      msTenantId: null,
      kind: 'human',
      locale: null,
      plan: 'free',
      workspaceName: 'example.com',
      storageUsedBytes: 0,
      storageQuotaBytes: 104857600,
      selfUploadEnabled: true,
    })
  })

  test('loadMcpUser exposes claimed domains for domain-claim workspaces', async () => {
    await seedWorkspace(db, { id: 'ws-claim', hd: null })
    await seedUser(db, {
      id: 'claim-user',
      workspaceId: 'ws-claim',
      email: 'claim-user@corp.com',
    })
    await db
      .insertInto('workspace_domain_claims')
      .values([
        {
          domain: 'another.example',
          workspace_id: 'ws-claim',
          source: 'microsoft_verified_domain',
          provider_tenant_id: 'tenant-1',
          created_at: NOW,
          updated_at: NOW,
        },
        {
          domain: 'corp.com',
          workspace_id: 'ws-claim',
          source: 'microsoft_verified_domain',
          provider_tenant_id: 'tenant-1',
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()

    const user = await loadMcpUser(db, 'claim-user')

    expect(user).toMatchObject({
      id: 'claim-user',
      workspaceId: 'ws-claim',
      hd: 'corp.com',
      msTenantId: null,
      kind: 'human',
    })
  })

  test('loadMcpUser preserves a Google hosted-domain alias', async () => {
    await seedWorkspace(db, { id: 'ws-google-alias', hd: null })
    await seedUser(db, {
      id: 'google-alias-user',
      workspaceId: 'ws-google-alias',
      email: 'user@alias.example',
    })
    await db
      .insertInto('workspace_domain_claims')
      .values([
        {
          domain: 'corp.com',
          workspace_id: 'ws-google-alias',
          source: 'google_hd',
          provider_tenant_id: null,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          domain: 'alias.example',
          workspace_id: 'ws-google-alias',
          source: 'microsoft_verified_domain',
          provider_tenant_id: 'tenant-other',
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()

    await expect(loadMcpUser(db, 'google-alias-user')).resolves.toMatchObject({
      workspaceId: 'ws-google-alias',
      hd: 'corp.com',
    })
  })

  test('loadMcpUser resolves a duplicate claim through the canonical tenant', async () => {
    await seedWorkspace(db, { id: 'ws-tenant', hd: null })
    await db
      .updateTable('workspaces')
      .set({ ms_tenant_id: 'tenant-1' })
      .where('id', '=', 'ws-tenant')
      .execute()
    await seedWorkspace(db, { id: 'ws-duplicate', hd: null })
    await seedUser(db, {
      id: 'tenant-user',
      workspaceId: 'ws-tenant',
      email: 'tenant-user@example.com',
    })
    await db
      .insertInto('workspace_domain_claims')
      .values({
        domain: 'example.com',
        workspace_id: 'ws-duplicate',
        source: 'microsoft_verified_domain',
        provider_tenant_id: 'tenant-1',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()

    await expect(loadMcpUser(db, 'tenant-user')).resolves.toMatchObject({
      workspaceId: 'ws-tenant',
      hd: 'example.com',
      msTenantId: 'tenant-1',
    })
  })

  test('loadMcpUser returns null for an unknown user', async () => {
    expect(await loadMcpUser(db, 'nobody')).toBeNull()
  })

  test('tools list advertises accurate tool annotations', async () => {
    const body = await callMcp(db, 'tools/list')
    const tools = body.result?.tools as Array<{
      name?: string
      annotations?: {
        readOnlyHint?: boolean
        destructiveHint?: boolean
        openWorldHint?: boolean
      }
    }>
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]))

    for (const name of [
      'share_artifact',
      'update_artifact',
      'append_artifact',
      'edit_artifact',
    ]) {
      expect(byName.get(name)).toMatchObject({
        openWorldHint: true,
        readOnlyHint: false,
      })
    }
    for (const name of ['post_comment', 'create_project', 'edit_project']) {
      expect(byName.get(name)?.openWorldHint).toBe(false)
    }
    for (const name of ['delete_artifact', 'delete_comment']) {
      expect(byName.get(name)).toMatchObject({
        destructiveHint: true,
        openWorldHint: false,
      })
    }
    for (const name of [
      'whoami',
      'list_artifacts',
      'get_artifact',
      'preview_artifact',
      'list_comments',
      'list_projects',
    ]) {
      expect(byName.get(name)).toMatchObject({
        destructiveHint: false,
        readOnlyHint: true,
      })
    }
  })

  test('write tool descriptions stay scoped to MCP behavior', async () => {
    const body = await callMcp(db, 'tools/list')
    const tools = body.result?.tools as Array<{
      name?: string
      description?: string
      inputSchema?: {
        properties?: Record<string, { description?: string }>
      }
    }>
    const byName = new Map(tools.map((tool) => [tool.name, tool.description]))
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('publish_artifact')
    expect(names).toContain('share_artifact')
    expect(names).toContain('append_artifact')
    expect(names).toContain('list_comments')
    expect(names).toContain('resolve_comment')
    expect(names).toContain('reopen_comment')

    expect(byName.get('share_artifact')).toContain(
      'Share one HTML or Markdown document from the content input',
    )
    expect(byName.get('update_artifact')).toContain(
      'The content input must contain the complete new source',
    )
    expect(byName.get('append_artifact')).toContain(
      'No newline or separator is inserted',
    )
    expect(byName.get('append_artifact')).toContain(
      'read the artifact with get_artifact before retrying',
    )
    const share = tools.find((tool) => tool.name === 'share_artifact')
    expect(share?.inputSchema?.properties?.visibility?.description).toContain(
      'private for a personal account',
    )
  })

  test('tool descriptions do not contain client routing or authentication instructions', async () => {
    const body = await callMcp(db, 'tools/list')
    const tools = body.result?.tools as Array<{
      name?: string
      description?: string
    }>
    const descriptions = tools.map((tool) => tool.description ?? '')
    for (const description of descriptions) {
      expect(description).not.toContain('Honor an explicit route choice')
      expect(description).not.toContain('otherwise route by capabilities')
      expect(description).not.toContain('MCP OAuth is separate')
      expect(description).not.toContain('auth_required')
      expect(description).not.toContain('npm exec')
      expect(description).not.toContain('briefly mention')
    }
  })

  test('get_artifact description names readback fields and continuation', async () => {
    const body = await callMcp(db, 'tools/list')
    const tools = body.result?.tools as Array<{
      name?: string
      description?: string
    }>
    const description = tools.find(
      (tool) => tool.name === 'get_artifact',
    )?.description
    expect(description).toContain('content')
    expect(description).toContain('version_id')
    expect(description).toContain('truncated:true')
    expect(description).toContain('next_offset')
    expect(description).toContain('concatenate the content parts')
  })

  test('advertises artifact URLs as a template and lists readable artifacts by title', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const markdown = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Derived title\n\nbody', 'markdown'),
      'private',
      [],
      null,
    )
    const html = await uploadShareable(
      db,
      user,
      buildArtifactFile(
        '<html><head><title>HTML title</title></head><body></body></html>',
        'html',
      ),
      'private',
      [],
      null,
    )
    if (markdown.kind !== 'ok' || html.kind !== 'ok') {
      throw new Error('publish failed')
    }
    await db
      .updateTable('shareables')
      .set({ title_override: 'Custom title' })
      .where('id', '=', markdown.id)
      .execute()

    const templates = await callMcp(db, 'resources/templates/list')
    expect(templates.error).toBeUndefined()
    expect(templates.result?.resourceTemplates).toEqual([
      {
        name: 'artifact',
        uriTemplate: 'https://artifactshare.com/a/{id}',
        title: 'Artifact Share artifact',
        description:
          'Reads the current Markdown or HTML source of an Artifact Share artifact.',
      },
    ])

    const listed = await callMcp(db, 'resources/list')
    expect(listed.error).toBeUndefined()
    expect(listed.result?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: `https://artifactshare.com/a/${markdown.id}`,
          name: `Custom title — https://artifactshare.com/a/${markdown.id}`,
          title: 'Custom title',
          description: 'Current Markdown source from Artifact Share.',
          mimeType: 'text/markdown',
        }),
        expect.objectContaining({
          uri: `https://artifactshare.com/a/${html.id}`,
          name: `HTML title — https://artifactshare.com/a/${html.id}`,
          title: 'HTML title',
          description: 'Current HTML source from Artifact Share.',
          mimeType: 'text/html',
        }),
      ]),
    )
    expect(listed.result?.resources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'ui://artifact-preview.html' }),
      ]),
    )

    const preview = await callMcp(db, 'resources/read', {
      uri: 'ui://artifact-preview.html',
    })
    expect(preview.error).toBeUndefined()
    expect(preview.result?.contents).toEqual([
      expect.objectContaining({
        uri: 'ui://artifact-preview.html',
        mimeType: 'text/html;profile=mcp-app',
      }),
    ])
  })

  test('does not reveal link-only artifacts in the resource list without identity-bound access', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    await seedUser(db, { id: 'mate-link-resource', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-link-resource')
    if (!mate) throw new Error('seed failed')
    const source = '# Unlisted link resource'
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile(source, 'markdown'),
      'link',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const uri = `https://artifactshare.com/a/${published.id}`
    const ungranted = await callMcp(db, 'resources/list')
    const ungrantedResources = ungranted.result?.resources as Array<{
      uri?: string
    }>
    expect(ungrantedResources.map((resource) => resource.uri)).not.toContain(
      uri,
    )

    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })
    const directRead = await callMcp(db, 'resources/read', { uri })
    expect(directRead.error).toBeUndefined()

    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: published.id,
        granted_email: 'OWNER-1@EXAMPLE.COM',
        granted_at: NOW,
        granted_by: mate.id,
      })
      .execute()
    const granted = await callMcp(db, 'resources/list')
    const grantedResources = granted.result?.resources as Array<{
      uri?: string
    }>
    expect(grantedResources.map((resource) => resource.uri)).toContain(uri)
  })

  test('omits unsupported artifacts and lists readable multibyte artifacts', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const unsupported = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Unsupported', 'markdown'),
      'private',
      [],
      null,
    )
    const multibyteSource = `# 日本語\n\n${'界'.repeat(70_000)}`
    const multibyte = await uploadShareable(
      db,
      user,
      buildArtifactFile(multibyteSource, 'markdown'),
      'private',
      [],
      null,
    )
    if (unsupported.kind !== 'ok' || multibyte.kind !== 'ok') {
      throw new Error('publish failed')
    }
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'static_site' })
      .where('shareable_id', '=', unsupported.id)
      .execute()
    storageMock.getArtifact.mockResolvedValue({
      text: async () => multibyteSource,
      size: new TextEncoder().encode(multibyteSource).byteLength,
    })
    const listed = await callMcp(db, 'resources/list')
    const resources = listed.result?.resources as Array<{ uri?: string }>
    expect(resources.map((resource) => resource.uri)).not.toContain(
      `https://artifactshare.com/a/${unsupported.id}`,
    )
    const multibyteUri = `https://artifactshare.com/a/${multibyte.id}`
    expect(resources.map((resource) => resource.uri)).toContain(multibyteUri)

    const read = await callMcp(db, 'resources/read', { uri: multibyteUri })
    expect(read.error).toBeUndefined()
    expect(read.result?.contents).toEqual([
      {
        uri: multibyteUri,
        mimeType: 'text/markdown',
        text: multibyteSource,
      },
    ])
  })

  test('stops listing a shared-project resource after its audience grant is removed', async () => {
    await seedWorkspace(db, { id: 'ws-b', hd: 'other.example' })
    await seedUser(db, {
      id: 'external-project-owner',
      workspaceId: 'ws-b',
      email: 'owner@other.example',
    })
    const externalOwner = await loadMcpUser(db, 'external-project-owner')
    if (!externalOwner) throw new Error('seed failed')
    const projectId = await createTestProject(db, 'ws-b', externalOwner.id, {
      name: 'Shared project',
      description: null,
      baseVisibility: 'private',
    })
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'audience-resource-list',
        project_container_id: projectId,
        email: 'OWNER-1@EXAMPLE.COM',
        role: 'viewer',
        display_name: null,
        created_by_id: externalOwner.id,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('project_members')
      .values({
        container_id: projectId,
        user_id: 'owner-1',
        joined_at: NOW,
        last_seen_at: NOW,
      })
      .execute()
    const published = await uploadShareable(
      db,
      externalOwner,
      buildArtifactFile('# Shared project resource', 'markdown'),
      'project',
      [],
      projectId,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    const uri = `https://artifactshare.com/a/${published.id}`

    const before = await callMcp(db, 'resources/list')
    const beforeResources = before.result?.resources as Array<{ uri?: string }>
    expect(beforeResources.map((resource) => resource.uri)).toContain(uri)

    await db
      .deleteFrom('project_share_defaults')
      .where('project_container_id', '=', projectId)
      .where('email', '=', 'OWNER-1@EXAMPLE.COM')
      .execute()

    const after = await callMcp(db, 'resources/list')
    const afterResources = after.result?.resources as Array<{ uri?: string }>
    expect(afterResources.map((resource) => resource.uri)).not.toContain(uri)
  })

  test('lists a BOM-prefixed resource at the character limit', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const decodedSource = '界'.repeat(200_000)
    const storedSource = `\uFEFF${decodedSource}`
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(storedSource, 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    storageMock.getArtifact.mockResolvedValue({
      text: async () => decodedSource,
      size: new TextEncoder().encode(storedSource).byteLength,
    })

    const listed = await callMcp(db, 'resources/list')
    const resources = listed.result?.resources as Array<{ uri?: string }>
    expect(resources.map((resource) => resource.uri)).toContain(
      `https://artifactshare.com/a/${published.id}`,
    )
  })

  test('bounds exact-length validation while continuing to list small resources', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const small = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Small', 'markdown'),
      'private',
      [],
      null,
    )
    if (small.kind !== 'ok') throw new Error('publish failed')
    const oversizedSource = 'x'.repeat(200_001)
    for (let index = 0; index < 11; index += 1) {
      const oversized = await uploadShareable(
        db,
        user,
        buildArtifactFile(oversizedSource, 'markdown'),
        'private',
        [],
        null,
      )
      if (oversized.kind !== 'ok') throw new Error('publish failed')
      await db
        .updateTable('shareables')
        .set({
          updated_at: `9999-12-31T23:59:${String(index).padStart(2, '0')}.999Z`,
        })
        .where('id', '=', oversized.id)
        .execute()
    }
    storageMock.getArtifact.mockResolvedValue({
      text: async () => oversizedSource,
      size: oversizedSource.length,
    })

    const listed = await callMcp(db, 'resources/list')
    const resources = listed.result?.resources as Array<{ uri?: string }>
    expect(storageMock.getArtifact).toHaveBeenCalledTimes(10)
    expect(resources.map((resource) => resource.uri)).toContain(
      `https://artifactshare.com/a/${small.id}`,
    )
  })

  test('returns 50 readable resources without letting a newer oversized artifact displace one', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    for (let index = 0; index < 50; index += 1) {
      const published = await uploadShareable(
        db,
        user,
        buildArtifactFile(`# Resource ${index}`, 'markdown'),
        'private',
        [],
        null,
      )
      if (published.kind !== 'ok') throw new Error('publish failed')
    }
    const oversizedSource = 'x'.repeat(200_001)
    const oversized = await uploadShareable(
      db,
      user,
      buildArtifactFile(oversizedSource, 'markdown'),
      'private',
      [],
      null,
    )
    if (oversized.kind !== 'ok') throw new Error('publish failed')
    await db
      .updateTable('shareables')
      .set({ updated_at: '9999-12-31T23:59:59.999Z' })
      .where('id', '=', oversized.id)
      .execute()
    storageMock.getArtifact.mockResolvedValue({
      text: async () => oversizedSource,
      size: oversizedSource.length,
    })

    const listed = await callMcp(db, 'resources/list')
    const resources = listed.result?.resources as Array<{ uri?: string }>
    const artifactResources = resources.filter((resource) =>
      resource.uri?.startsWith('https://artifactshare.com/a/'),
    )
    expect(artifactResources).toHaveLength(50)
    expect(artifactResources.map((resource) => resource.uri)).not.toContain(
      `https://artifactshare.com/a/${oversized.id}`,
    )
  })

  test.each([
    ['markdown', '# Resource\n\nbody', 'text/markdown'],
    ['html', '<html><body>Resource</body></html>', 'text/html'],
  ] as const)(
    'reads a viewable %s artifact through resources/read',
    async (format, source, mimeType) => {
      const user = await loadMcpUser(db, 'owner-1')
      if (!user) throw new Error('seed failed')
      const published = await uploadShareable(
        db,
        user,
        buildArtifactFile(source, format),
        'private',
        [],
        null,
      )
      if (published.kind !== 'ok') throw new Error('publish failed')
      storageMock.getArtifact.mockResolvedValue({
        text: async () => source,
        size: source.length,
      })

      const uri = `https://artifactshare.com/a/${published.id}`
      const body = await callMcp(db, 'resources/read', { uri })

      expect(body.error).toBeUndefined()
      expect(body.result?.contents).toEqual([{ uri, mimeType, text: source }])
    },
  )

  test('ignores viewer state when reading an artifact resource URL', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const source = '# Resource with viewer state'
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(source, 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })

    const uri = `https://artifactshare.com/a/${published.id}?comment=thread-1#message-1`
    const body = await callMcp(db, 'resources/read', { uri })

    expect(body.error).toBeUndefined()
    expect(body.result?.contents).toEqual([
      { uri, mimeType: 'text/markdown', text: source },
    ])
  })

  test('reads a workspace artifact owned by another user', async () => {
    await seedUser(db, { id: 'mate-shared-resource', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-shared-resource')
    if (!mate) throw new Error('seed failed')
    const source = '# Shared resource'
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile(source, 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })

    const uri = `https://artifactshare.com/a/${published.id}`
    const body = await callMcp(db, 'resources/read', { uri })

    expect(body.error).toBeUndefined()
    expect(body.result?.contents).toEqual([
      { uri, mimeType: 'text/markdown', text: source },
    ])
  })

  test('does not distinguish a hidden artifact from a missing artifact resource', async () => {
    await seedUser(db, { id: 'mate-resource', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-resource')
    if (!mate) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Private', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const hidden = await callMcp(db, 'resources/read', {
      uri: `https://artifactshare.com/a/${published.id}`,
    })
    const missing = await callMcp(db, 'resources/read', {
      uri: new URL('/a/not-present', 'https://artifactshare.com').href,
    })

    expect(hidden.error).toEqual(missing.error)
    expect(hidden.error).toEqual({
      code: -32602,
      message: 'MCP error -32602: Artifact resource is not available.',
    })
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test.each(['static_site', 'spa', 'workspace_app'] as const)(
    'refuses the unsupported %s artifact kind as a resource',
    async (artifactKind) => {
      const user = await loadMcpUser(db, 'owner-1')
      if (!user) throw new Error('seed failed')
      const published = await uploadShareable(
        db,
        user,
        buildArtifactFile('# Bundle', 'markdown'),
        'private',
        [],
        null,
      )
      if (published.kind !== 'ok') throw new Error('publish failed')
      await db
        .updateTable('shareables')
        .set({ artifact_kind: artifactKind })
        .where('id', '=', published.id)
        .execute()
      await db
        .updateTable('versions')
        .set({ artifact_kind: artifactKind })
        .where('shareable_id', '=', published.id)
        .execute()

      const body = await callMcp(db, 'resources/read', {
        uri: `https://artifactshare.com/a/${published.id}`,
      })

      expect(body.error).toEqual({
        code: -32602,
        message: 'MCP error -32602: Artifact resource type is not supported.',
      })
      expect(storageMock.getArtifact).not.toHaveBeenCalled()
    },
  )

  test('refuses a large artifact resource instead of returning partial content', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Large', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    const source = 'x'.repeat(200_001)
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })

    const body = await callMcp(db, 'resources/read', {
      uri: `https://artifactshare.com/a/${published.id}`,
    })

    expect(body.result).toBeUndefined()
    expect(body.error).toEqual({
      code: -32602,
      message:
        'MCP error -32602: Artifact resource exceeds the supported size.',
    })
  })

  test('applies the per-user rate limit to artifact resources', async () => {
    const limiter: RateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: false }),
    }

    const body = await callMcp(
      db,
      'resources/read',
      { uri: new URL('/a/any-id', 'https://artifactshare.com').href },
      { perUser: limiter, perWorkspace: null },
    )

    expect(limiter.limit).toHaveBeenCalledWith({ key: 'mcp:user:owner-1' })
    expect(body.error).toEqual({
      code: -32001,
      message: 'MCP error -32001: Artifact resource read is rate limited.',
    })
  })

  test('reports unavailable source as a resource protocol error', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Missing source', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    storageMock.getArtifact.mockResolvedValue(null)

    const body = await callMcp(db, 'resources/read', {
      uri: `https://artifactshare.com/a/${published.id}`,
    })

    expect(body.error).toEqual({
      code: -32603,
      message: 'MCP error -32603: Artifact resource content is unavailable.',
    })
  })

  test('publishes an HTML string and reads it back through the list query', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')

    const file = buildArtifactFile(
      '<!DOCTYPE html><html><head><title>Q2 Report</title></head><body><p>hi</p></body></html>',
      inferFormat('<!DOCTYPE html><html></html>'),
    )
    const result = await uploadShareable(db, user, file, 'workspace', [], null)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const kind = await db
      .selectFrom('shareables')
      .select('artifact_kind')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(kind.artifact_kind).toBe('html_page')

    const summary = await getOwnedShareableSummary(db, user, result.id)
    expect(summary).toMatchObject({
      id: result.id,
      title: 'Q2 Report',
      visibility: 'workspace',
    })

    const list = await listOwnedShareables(db, user)
    expect(list.map((s) => s.id)).toEqual([result.id])
  })

  test('a markdown string becomes a markdown_page', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')

    const file = buildArtifactFile(
      '# Roadmap\n\nbody',
      inferFormat('# Roadmap'),
    )
    const result = await uploadShareable(db, user, file, 'private', [], null)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const row = await db
      .selectFrom('shareables')
      .select(['artifact_kind', 'derived_title'])
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(row.artifact_kind).toBe('markdown_page')
    expect(row.derived_title).toBe('Roadmap')
  })

  test('update_artifact replaces the version while keeping the id', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')

    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('<p>v1</p>', 'html'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    const updated = await createVersion({
      db,
      user,
      shareableId: published.id,
      file: buildArtifactFile('<p>v2</p>', 'html'),
    })
    expect(updated.kind).toBe('ok')
    if (updated.kind !== 'ok') return

    const current = await db
      .selectFrom('shareables')
      .select('current_version_id')
      .where('id', '=', published.id)
      .executeTakeFirstOrThrow()
    expect(current.current_version_id).toBe(updated.versionId)
  })

  test('append_artifact appends inline content without a separator', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# First', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    storageMock.getArtifact.mockResolvedValue({
      body: new Blob(['# First']).stream(),
      size: 7,
    })

    const body = await callTool(db, 'append_artifact', {
      id: published.id,
      content: '\nSecond',
    })

    expect(body.error).toBeUndefined()
    const uploaded = storageMock.putArtifact.mock.calls.at(-1)?.[2]
    expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
      '# First\nSecond',
    )
  })

  test('append_artifact inserts inline HTML before the body close', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const source = '<html><body><p>First</p></body></html>'
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(source, 'html'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    storageMock.getArtifact.mockResolvedValue({
      body: new Blob([source]).stream(),
      size: source.length,
    })

    const body = await callTool(db, 'append_artifact', {
      id: published.id,
      content: '<p>Second</p>',
    })

    expect(body.error).toBeUndefined()
    const uploaded = storageMock.putArtifact.mock.calls.at(-1)?.[2]
    expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
      '<html><body><p>First</p><p>Second</p></body></html>',
    )
  })

  test('listOwnedShareables honours the limit (the has_more probe)', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')

    for (let i = 0; i < 3; i++) {
      const published = await uploadShareable(
        db,
        user,
        buildArtifactFile(`<p>n${i}</p>`, 'html'),
        'private',
        [],
        null,
      )
      expect(published.kind).toBe('ok')
    }

    const probe = await listOwnedShareables(db, user, { limit: 2 })
    expect(probe).toHaveLength(2)
    const all = await listOwnedShareables(db, user)
    expect(all).toHaveLength(3)
  })

  test('whoami runs through the SDK and its structuredContent passes the outputSchema', async () => {
    const body = await callTool(db, 'whoami')
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      connected: true,
      user_id: 'owner-1',
      can_publish: true,
      plan: 'free',
    })
  })

  test('share_artifact runs through the SDK and returns a share link', async () => {
    const body = await callTool(db, 'share_artifact', {
      content: '<!DOCTYPE html><html><head><title>SDK</title></head></html>',
      visibility: 'workspace',
    })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        id?: string
        share_url?: string
        visibility?: string
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.visibility).toBe('workspace')
    expect(result.structuredContent?.share_url).toMatch(
      /^https:\/\/artifactshare\.com\/a\/.+/,
    )
  })

  test('share_artifact dedups an identical resend instead of duplicating', async () => {
    const args = {
      content: '<!DOCTYPE html><html><head><title>Twice</title></head></html>',
      visibility: 'workspace',
    }
    const first = await callTool(db, 'share_artifact', args)
    const second = await callTool(db, 'share_artifact', args)
    const firstId = (first.result as { structuredContent?: { id?: string } })
      .structuredContent?.id
    const secondId = (second.result as { structuredContent?: { id?: string } })
      .structuredContent?.id
    expect(firstId).toBeTruthy()
    expect(secondId).toBe(firstId)

    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const owned = await listOwnedShareables(db, user)
    expect(owned.map((s) => s.id)).toEqual([firstId])

    const posts = await db
      .selectFrom('mcp_artifact_posts')
      .select(['shareable_id', 'action', 'client_id'])
      .execute()
    expect(posts).toEqual([
      { shareable_id: firstId, action: 'publish', client_id: 'client-1' },
    ])
  })

  test('a changed visibility is a new artifact, not an idempotent resend', async () => {
    const content = '# Same body, different scope'
    const a = await callTool(db, 'share_artifact', {
      content,
      visibility: 'workspace',
    })
    const b = await callTool(db, 'share_artifact', {
      content,
      visibility: 'private',
    })
    const aId = (a.result as { structuredContent?: { id?: string } })
      .structuredContent?.id
    const bId = (b.result as { structuredContent?: { id?: string } })
      .structuredContent?.id
    expect(aId).toBeTruthy()
    expect(bId).toBeTruthy()
    expect(bId).not.toBe(aId)
  })

  test('share_artifact files the artifact under a project and inherits its scope', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Launch',
      description: null,
      baseVisibility: 'workspace',
    })
    const body = await callTool(db, 'share_artifact', {
      content: '# Filed under a project',
      project_id: projectId,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        id?: string
        visibility?: string
        visibility_label?: string
      }
    }
    expect(result.isError).toBeFalsy()
    // No visibility was given, so it inherits the project scope instead of the
    // workspace default an unfiled publish would get.
    expect(result.structuredContent?.visibility).toBe('project')
    expect(result.structuredContent?.visibility_label).toBe('Project')
    const row = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', result.structuredContent?.id ?? '')
      .executeTakeFirst()
    expect(row?.container_id).toBe(projectId)
  })

  test('share_artifact into a project still honors an explicit visibility', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Restricted',
      description: null,
      baseVisibility: 'workspace',
    })
    const body = await callTool(db, 'share_artifact', {
      content: '# Private inside a project',
      project_id: projectId,
      visibility: 'private',
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { id?: string; visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.visibility).toBe('private')
    const row = await db
      .selectFrom('shareables')
      .select(['container_id', 'visibility'])
      .where('id', '=', result.structuredContent?.id ?? '')
      .executeTakeFirst()
    expect(row?.container_id).toBe(projectId)
    expect(row?.visibility).toBe('private')
  })

  test('share_artifact rejects a project_id that is not a project in the workspace', async () => {
    const body = await callTool(db, 'share_artifact', {
      content: '# Nowhere',
      project_id: 'no-such-project',
    })
    const payload = errorPayload(body)
    expect(payload.code).toBe('invalid-destination')
    expect(payload.recoverable_by).toBe('agent')
  })

  test('share_artifact cannot file into another workspace project', async () => {
    await seedWorkspace(db, { id: 'ws-b', hd: 'other.com' })
    await seedUser(db, { id: 'other-1', workspaceId: 'ws-b' })
    const foreignProject = await createTestProject(db, 'ws-b', 'other-1', {
      name: 'Theirs',
      description: null,
      baseVisibility: 'workspace',
    })
    const body = await callTool(db, 'share_artifact', {
      content: '# Cross-workspace',
      project_id: foreignProject,
    })
    expect(errorPayload(body).code).toBe('invalid-destination')
    // The rejection must happen before any write — no artifact may leak into
    // either workspace.
    const leaked = await db.selectFrom('shareables').select('id').execute()
    expect(leaked).toEqual([])
  })

  test('edit_artifact files an unfiled artifact into a project', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Launch',
      description: null,
      baseVisibility: 'workspace',
    })
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Loose doc', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      project_id: projectId,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { project_id?: string | null; visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.project_id).toBe(projectId)
    // Filing a workspace-visible artifact under a project leaves its scope alone.
    expect(result.structuredContent?.visibility).toBe('workspace')
    const row = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', published.id)
      .executeTakeFirst()
    expect(row?.container_id).toBe(projectId)
  })

  test('edit_artifact returns a project artifact to the inbox and narrows its scope', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Launch',
      description: null,
      baseVisibility: 'workspace',
    })
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Filed, then unfiled', 'markdown'),
      'project',
      [],
      projectId,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    // An empty project_id is the explicit "return to the unfiled inbox" signal;
    // omitting it would leave the location unchanged.
    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      project_id: '',
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        project_id?: string | null
        visibility?: string
        visibility_label?: string
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.project_id).toBeNull()
    // The inbox has no audience to inherit from, so a project-scoped artifact
    // can't stay 'project' — it narrows to private, never wider.
    expect(result.structuredContent?.visibility).toBe('private')
    expect(result.structuredContent?.visibility_label).toBe('Specific')
    const row = await db
      .selectFrom('shareables')
      .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
      .select(['shareables.visibility as visibility', 'c.kind as kind'])
      .where('shareables.id', '=', published.id)
      .executeTakeFirst()
    expect(row?.visibility).toBe('private')
    expect(row?.kind).toBe('inbox')
  })

  test('edit_artifact filing a private artifact into a company-wide project keeps it private', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Everyone in this workspace',
      description: null,
      baseVisibility: 'workspace',
    })
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Kept private', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      project_id: projectId,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    // The core guarantee: filing a private artifact into a workspace-wide project
    // must not widen it to 'workspace'. A move never expands who can view it.
    expect(result.structuredContent?.visibility).toBe('private')
    const row = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', published.id)
      .executeTakeFirst()
    expect(row?.visibility).toBe('private')
  })

  test('edit_artifact moves an artifact between projects and keeps the project scope', async () => {
    const projectA = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'A',
      description: null,
      baseVisibility: 'workspace',
    })
    const projectB = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'B',
      description: null,
      baseVisibility: 'private',
    })
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Reparented', 'markdown'),
      'project',
      [],
      projectA,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      project_id: projectB,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { project_id?: string | null; visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.project_id).toBe(projectB)
    // project → project keeps 'project'; the destination project's audience now
    // applies, but the stored scope value is unchanged.
    expect(result.structuredContent?.visibility).toBe('project')
    const row = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', published.id)
      .executeTakeFirst()
    expect(row?.container_id).toBe(projectB)
  })

  test('edit_artifact rejects a project_id that is not a project in the workspace', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Stays put', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      project_id: 'no-such-project',
    })
    expect(errorPayload(body).code).toBe('invalid-destination')
    // A rejected move must not relocate the artifact.
    const row = await db
      .selectFrom('shareables')
      .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
      .select('c.kind as kind')
      .where('shareables.id', '=', published.id)
      .executeTakeFirst()
    expect(row?.kind).toBe('inbox')
  })

  test('edit_artifact cannot move an artifact owned by another member', async () => {
    await seedUser(db, { id: 'mate-1', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-1')
    if (!mate) throw new Error('seed failed')
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Launch',
      description: null,
      baseVisibility: 'workspace',
    })
    const theirs = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Theirs', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (theirs.kind !== 'ok') throw new Error('publish failed')

    // owner-1 (the callTool identity) is not a workspace admin, so they can only
    // move artifacts they own; a co-member's file is reported not-found.
    const body = await callTool(db, 'edit_artifact', {
      id: theirs.id,
      project_id: projectId,
    })
    expect(errorPayload(body).code).toBe('not-found')
    const row = await db
      .selectFrom('shareables')
      .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
      .select('c.kind as kind')
      .where('shareables.id', '=', theirs.id)
      .executeTakeFirst()
    expect(row?.kind).toBe('inbox')
  })

  test('edit_artifact renames an artifact and reports the new title', async () => {
    const { id } = await publishOwnerDoc('# Original\n\nbody')
    const body = await callTool(db, 'edit_artifact', { id, title: 'Renamed' })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { title?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.title).toBe('Renamed')
    const row = await db
      .selectFrom('shareables')
      .select('title_override')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.title_override).toBe('Renamed')
  })

  test('edit_artifact clears the title override when passed an empty string', async () => {
    const { id } = await publishOwnerDoc('# Derived heading\n\nbody')
    await callTool(db, 'edit_artifact', { id, title: 'Override' })
    const body = await callTool(db, 'edit_artifact', { id, title: '' })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { title?: string }
    }
    expect(result.isError).toBeFalsy()
    // Cleared override falls back to the content-derived title, not '' .
    expect(result.structuredContent?.title).toBe('Derived heading')
    const row = await db
      .selectFrom('shareables')
      .select('title_override')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.title_override).toBeNull()
  })

  test('edit_artifact widens a private artifact to the whole workspace', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Private then shared', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      visibility: 'workspace',
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.visibility).toBe('workspace')
    const row = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', published.id)
      .executeTakeFirst()
    expect(row?.visibility).toBe('workspace')
  })

  test('edit_artifact adds and removes specific viewers', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Shared with people', 'markdown'),
      'private',
      ['early@example.com'],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      add_emails: ['added@example.com'],
      remove_emails: ['early@example.com'],
    })
    const result = body.result as { isError?: boolean }
    expect(result.isError).toBeFalsy()
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', published.id)
      .execute()
    const emails = grants.map((g) => g.granted_email)
    expect(emails).toContain('added@example.com')
    expect(emails).not.toContain('early@example.com')
  })

  test('edit_artifact applies a rename, a scope change, and a move in one call', async () => {
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Launch',
      description: null,
      baseVisibility: 'workspace',
    })
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Everything at once', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'edit_artifact', {
      id: published.id,
      title: 'Launch plan',
      visibility: 'workspace',
      project_id: projectId,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        title?: string
        visibility?: string
        project_id?: string | null
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.title).toBe('Launch plan')
    // The explicit visibility wins over the move's default handling.
    expect(result.structuredContent?.visibility).toBe('workspace')
    expect(result.structuredContent?.project_id).toBe(projectId)
    const row = await db
      .selectFrom('shareables')
      .select(['container_id', 'visibility', 'title_override'])
      .where('id', '=', published.id)
      .executeTakeFirst()
    expect(row?.container_id).toBe(projectId)
    expect(row?.visibility).toBe('workspace')
    expect(row?.title_override).toBe('Launch plan')
  })

  test('edit_artifact with no fields leaves the artifact unchanged', async () => {
    const { id } = await publishOwnerDoc('# Untouched\n\nbody')
    const body = await callTool(db, 'edit_artifact', { id })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { project_id?: string | null; visibility?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.project_id).toBeNull()
    expect(result.structuredContent?.visibility).toBe('workspace')
  })

  test('edit_artifact reports not-found for an artifact the caller does not own', async () => {
    const body = await callTool(db, 'edit_artifact', {
      id: 'no-such-id',
      title: 'Nope',
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('delete_artifact removes an owned artifact and its versions', async () => {
    const { id } = await publishOwnerDoc('# Disposable\n\nbody')
    const body = await callTool(db, 'delete_artifact', { id })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { id?: string; deleted?: boolean }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ id, deleted: true })
    const rows = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', id)
      .execute()
    expect(rows).toEqual([])
    const versions = await db
      .selectFrom('versions')
      .select('id')
      .where('shareable_id', '=', id)
      .execute()
    expect(versions).toEqual([])
  })

  test('delete_artifact reports not-found for an unknown id', async () => {
    const body = await callTool(db, 'delete_artifact', { id: 'no-such-id' })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('delete_artifact cannot delete an artifact owned by another member', async () => {
    await seedUser(db, { id: 'mate-2', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-2')
    if (!mate) throw new Error('seed failed')
    const theirs = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Theirs', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (theirs.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'delete_artifact', { id: theirs.id })
    expect(errorPayload(body).code).toBe('not-found')
    // The co-member's artifact must survive the rejected delete.
    const rows = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', theirs.id)
      .execute()
    expect(rows).toEqual([{ id: theirs.id }])
  })

  test('update_artifact records an update post for the audit trail', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('<p>v1</p>', 'html'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    const body = await callTool(db, 'update_artifact', {
      id: published.id,
      content: '<p>v2</p>',
    })
    expect(body.error).toBeUndefined()

    const posts = await db
      .selectFrom('mcp_artifact_posts')
      .select(['shareable_id', 'action', 'client_id'])
      .where('action', '=', 'update')
      .execute()
    expect(posts).toEqual([
      { shareable_id: published.id, action: 'update', client_id: 'client-1' },
    ])
  })

  test('list_artifacts runs through the SDK on normal data', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    await uploadShareable(
      db,
      user,
      buildArtifactFile('<p>a</p>', 'html'),
      'workspace',
      [],
      null,
    )
    const body = await callTool(db, 'list_artifacts')
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: { artifacts?: unknown[]; has_more?: boolean }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.artifacts).toHaveLength(1)
  })

  type ListArtifactEntry = {
    id?: string
    title?: string
    project_id?: string | null
  }

  function listArtifacts(body: {
    result?: Record<string, unknown>
  }): ListArtifactEntry[] {
    const result = body.result as {
      isError?: boolean
      structuredContent?: { artifacts?: ListArtifactEntry[] }
    }
    expect(result.isError).toBeFalsy()
    return result.structuredContent?.artifacts ?? []
  }

  test('list_artifacts filters by project and reports placement', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const projectId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Filed',
      description: null,
      baseVisibility: 'workspace',
    })
    const filed = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Filed doc', 'markdown'),
      'workspace',
      [],
      projectId,
    )
    if (filed.kind !== 'ok') throw new Error('publish failed')
    const loose = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Loose doc', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (loose.kind !== 'ok') throw new Error('publish failed')

    const inProject = listArtifacts(
      await callTool(db, 'list_artifacts', { project_id: projectId }),
    )
    expect(inProject.map((a) => a.id)).toEqual([filed.id])
    expect(inProject[0]?.project_id).toBe(projectId)

    const inInbox = listArtifacts(
      await callTool(db, 'list_artifacts', { project_id: '' }),
    )
    expect(inInbox.map((a) => a.id)).toEqual([loose.id])
    expect(inInbox[0]?.project_id).toBeNull()

    const all = listArtifacts(await callTool(db, 'list_artifacts'))
    expect(all.map((a) => a.id).sort()).toEqual([filed.id, loose.id].sort())
  })

  test('list_artifacts searches titles case-insensitively', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const report = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Quarterly Report', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (report.kind !== 'ok') throw new Error('publish failed')
    const notes = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Meeting Notes', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (notes.kind !== 'ok') throw new Error('publish failed')

    const matches = listArtifacts(
      await callTool(db, 'list_artifacts', { query: 'report' }),
    )
    expect(matches.map((a) => a.id)).toEqual([report.id])
  })

  test('list_artifacts with project_id includes other members artifacts with owner_email', async () => {
    await seedUser(db, { id: 'mate-9', workspaceId: 'ws-a' })
    const owner = await loadMcpUser(db, 'owner-1')
    const mate = await loadMcpUser(db, 'mate-9')
    if (!owner || !mate) throw new Error('seed failed')
    const projectId = await createTestProject(db, 'ws-a', 'mate-9', {
      name: 'Shared work',
      description: null,
      baseVisibility: 'workspace',
    })
    const theirs = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Their doc', 'markdown'),
      'workspace',
      [],
      projectId,
    )
    if (theirs.kind !== 'ok') throw new Error('publish failed')

    const inProject = listArtifacts(
      await callTool(db, 'list_artifacts', { project_id: projectId }),
    )
    expect(inProject.map((a) => a.id)).toEqual([theirs.id])
    expect(
      (inProject[0] as { owner_email?: string } | undefined)?.owner_email,
    ).toBe('mate-9@example.com')

    // Negative control: the unfiltered listing stays owner-scoped.
    const all = listArtifacts(await callTool(db, 'list_artifacts'))
    expect(all.map((a) => a.id)).not.toContain(theirs.id)
  })

  test('list_artifacts rejects an invalid cursor as a tool error', async () => {
    const body = await callTool(db, 'list_artifacts', { cursor: 'broken' })
    expect((body.result as { isError?: boolean }).isError).toBe(true)
    const error = errorPayload(body)
    expect(error.code).toBe('validation_failed')
    expect(error.recoverable_by).toBe('agent')
  })

  test('list_artifacts treats LIKE wildcards in the query literally', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const literal = await uploadShareable(
      db,
      user,
      buildArtifactFile('# 100% complete', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (literal.kind !== 'ok') throw new Error('publish failed')
    await uploadShareable(
      db,
      user,
      buildArtifactFile('# Half done', 'markdown'),
      'workspace',
      [],
      null,
    )

    // '%' must match a literal percent, not act as a wildcard.
    const matches = listArtifacts(
      await callTool(db, 'list_artifacts', { query: '100%' }),
    )
    expect(matches.map((a) => a.id)).toEqual([literal.id])
  })

  test('get_artifact reads back the markdown source the agent can round-trip', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Title\n\nbody', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    storageMock.getArtifact.mockResolvedValue({
      text: async () => '# Title\n\nbody',
      size: 13,
    })
    const body = await callTool(db, 'get_artifact', { id: published.id })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        format?: string
        content?: string
        truncated?: boolean
        size_bytes?: number
        version_id?: string
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      format: 'markdown',
      content: '# Title\n\nbody',
      truncated: false,
      size_bytes: 13,
    })
    expect(result.structuredContent?.version_id).toBeTruthy()
  })

  test('get_artifact paginates a large source via offset and next_offset', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const big = `${'x'.repeat(200_000)}tail`
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(big, 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    storageMock.getArtifact.mockResolvedValue({
      text: async () => big,
      size: big.length,
    })

    const first = await callTool(db, 'get_artifact', { id: published.id })
    const firstResult = first.result as {
      structuredContent?: {
        content?: string
        truncated?: boolean
        next_offset?: number | null
      }
    }
    expect(firstResult.structuredContent?.truncated).toBe(true)
    expect(firstResult.structuredContent?.content).toHaveLength(200_000)
    expect(firstResult.structuredContent?.next_offset).toBe(200_000)

    const second = await callTool(db, 'get_artifact', {
      id: published.id,
      offset: 200_000,
    })
    const secondResult = second.result as {
      structuredContent?: {
        content?: string
        truncated?: boolean
        next_offset?: number | null
      }
    }
    expect(secondResult.structuredContent?.content).toBe('tail')
    expect(secondResult.structuredContent?.truncated).toBe(false)
    expect(secondResult.structuredContent?.next_offset).toBeNull()
  })

  test('get_artifact returns html source for an html_page', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(
        '<!DOCTYPE html><html><head><title>T</title></head><body>hi</body></html>',
        'html',
      ),
      'workspace',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    storageMock.getArtifact.mockResolvedValue({
      text: async () => '<html>hi</html>',
      size: 15,
    })
    const body = await callTool(db, 'get_artifact', { id: published.id })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { format?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.format).toBe('html')
  })

  test('get_artifact refuses a multi-file bundle kind', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# x', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    // Promote the shareable and its current version to a bundle kind without
    // building a real bundle — the tool must refuse it before touching R2.
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'static_site' })
      .where('id', '=', published.id)
      .execute()
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'static_site' })
      .where('shareable_id', '=', published.id)
      .execute()

    const body = await callTool(db, 'get_artifact', { id: published.id })
    expect(errorPayload(body).code).toBe('unsupported-kind')
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('get_artifact returns not-found for an id you cannot view', async () => {
    const body = await callTool(db, 'get_artifact', { id: 'nope' })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('preview_artifact returns portable card metadata for a viewable artifact', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# Title\n\nbody', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    const body = await callTool(db, 'preview_artifact', { id: published.id })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      content?: Array<{ text?: string }>
      structuredContent?: {
        id?: string
        share_url?: string
        title?: string | null
        artifact_kind?: string
        locale?: string
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.id).toBe(published.id)
    expect(result.structuredContent?.share_url).toBe(
      `https://artifactshare.com/a/${published.id}`,
    )
    expect(result.structuredContent?.artifact_kind).toBe('markdown_page')
    expect(result.structuredContent).not.toHaveProperty('preview_url')
    expect(typeof result.structuredContent?.locale).toBe('string')
    const text = result.content?.[0]?.text ?? ''
    expect(text).not.toContain('.sandbox.')
    expect(text).not.toContain('t=')
  })

  test('preview_artifact returns card metadata for a multi-file bundle', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# x', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'static_site' })
      .where('id', '=', published.id)
      .execute()
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'static_site' })
      .where('shareable_id', '=', published.id)
      .execute()

    const body = await callTool(db, 'preview_artifact', { id: published.id })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { share_url?: string; artifact_kind?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.share_url).toBe(
      `https://artifactshare.com/a/${published.id}`,
    )
    expect(result.structuredContent?.artifact_kind).toBe('static_site')
    expect(result.structuredContent).not.toHaveProperty('preview_url')
  })

  test('preview_artifact preserves an unknown artifact kind for card fallback', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('# x', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'legacy_kind' as ArtifactKind })
      .where('id', '=', published.id)
      .execute()
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'legacy_kind' as ArtifactKind })
      .where('shareable_id', '=', published.id)
      .execute()

    const body = await callTool(db, 'preview_artifact', { id: published.id })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { artifact_kind?: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.artifact_kind).toBe('legacy_kind')
  })

  test('preview_artifact returns not-found for an id you cannot view', async () => {
    const body = await callTool(db, 'preview_artifact', { id: 'nope' })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('get_artifact include versions lists history and flags the current version', async () => {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile('<p>v1</p>', 'html'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    const updated = await createVersion({
      db,
      user,
      shareableId: published.id,
      file: buildArtifactFile('<p>v2</p>', 'html'),
    })
    expect(updated.kind).toBe('ok')
    if (updated.kind !== 'ok') return

    storageMock.getArtifact.mockResolvedValue({
      text: async () => '<p>v2</p>',
      size: 9,
    })
    const body = await callTool(db, 'get_artifact', {
      id: published.id,
      include: ['versions'],
    })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        versions?: Array<{ version_id: string; is_current: boolean }>
        versions_has_more?: boolean
      }
    }
    expect(result.isError).toBeFalsy()
    const versions = result.structuredContent?.versions ?? []
    expect(versions).toHaveLength(2)
    expect(result.structuredContent?.versions_has_more).toBe(false)
    const current = versions.filter((v) => v.is_current)
    expect(current).toHaveLength(1)
    expect(current[0]?.version_id).toBe(updated.versionId)
  })

  test('get_artifact omits versions when include is not passed', async () => {
    const { id } = await publishOwnerDoc('# Plain\n\nbody')
    storageMock.getArtifact.mockResolvedValue({
      text: async () => '# Plain\n\nbody',
      size: 13,
    })
    const body = await callTool(db, 'get_artifact', { id })
    const result = body.result as {
      structuredContent?: Record<string, unknown>
    }
    expect(result.structuredContent).not.toHaveProperty('versions')
  })

  test('get_artifact rejects comments include', async () => {
    const { id } = await publishOwnerDoc('# Plain\n\nbody')
    const body = await callTool(db, 'get_artifact', {
      id,
      include: ['comments'],
    })
    expect(body.error).toBeUndefined()
    expect((body.result as { isError?: boolean }).isError).toBe(true)
    expect(storageMock.getArtifact).not.toHaveBeenCalled()
  })

  test('list_comments returns threads with messages and ids', async () => {
    const { sessionUser, id } = await publishOwnerDoc()
    const access = await loadCommentAccess(db, sessionUser, id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(
      db,
      access,
      sessionUser,
      'Looks good to me',
    )
    expect(created.kind).toBe('ok')

    const body = await callTool(db, 'list_comments', { id })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        artifact_id?: string
        comments?: Array<{
          status?: string
          anchor?: { kind?: string }
          messages?: Array<{
            message_id?: string
            body?: string
            author_email?: string
          }>
        }>
        comments_has_more?: boolean
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.artifact_id).toBe(id)
    const threads = result.structuredContent?.comments ?? []
    expect(threads).toHaveLength(1)
    expect(threads[0]?.status).toBe('open')
    expect(threads[0]?.anchor?.kind).toBe('artifact')
    expect(threads[0]?.messages?.[0]?.body).toBe('Looks good to me')
    expect(threads[0]?.messages?.[0]?.author_email).toBe('owner-1@example.com')
    // The message id is exposed so update_comment / delete_comment can target it.
    expect(threads[0]?.messages?.[0]?.message_id).toBeTruthy()
    expect(result.structuredContent?.comments_has_more).toBe(false)
  })

  test('list_comments reads a colleague’s shared artifact comments', async () => {
    await seedUser(db, { id: 'mate-6', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-6')
    if (!mate) throw new Error('seed failed')
    const mateSession = mcpUserAsSessionUser(mate)
    // A workspace-visible artifact mate published; owner-1 (the caller) can view
    // it but does not own it.
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Shared doc\n\nbody', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    const access = await loadCommentAccess(db, mateSession, published.id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(
      db,
      access,
      mateSession,
      'Mate left a note',
    )
    if (created.kind !== 'ok') throw new Error('seed thread failed')

    const body = await callTool(db, 'list_comments', {
      id: published.id,
    })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        comments?: Array<{ messages?: Array<{ body?: string }> }>
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.comments?.[0]?.messages?.[0]?.body).toBe(
      'Mate left a note',
    )
  })

  test('get_artifact omits versions for an artifact you do not own', async () => {
    await seedUser(db, { id: 'mate-7', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-7')
    if (!mate) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Theirs\n\nbody', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    storageMock.getArtifact.mockResolvedValue({
      text: async () => '# Theirs\n\nbody',
      size: 13,
    })
    const body = await callTool(db, 'get_artifact', {
      id: published.id,
      include: ['versions'],
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(result.isError).toBeFalsy()
    // Version history is authoring detail, so it isn't returned for others' work.
    expect(result.structuredContent).not.toHaveProperty('versions')
  })

  test('list_comments refuses a colleague’s private artifact not shared with you', async () => {
    await seedUser(db, { id: 'mate-8', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-8')
    if (!mate) throw new Error('seed failed')
    // Same workspace, but private and not granted to owner-1 — must stay hidden.
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Mate private', 'markdown'),
      'private',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')

    const body = await callTool(db, 'list_comments', {
      id: published.id,
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('list_comments refuses an artifact in another workspace', async () => {
    // A private artifact owned by someone in another workspace is not viewable,
    // so get_artifact yields not-found rather than leaking source or threads.
    await seedWorkspace(db, { id: 'ws-b', hd: 'other.com' })
    await seedUser(db, { id: 'other-1', workspaceId: 'ws-b' })
    const other = await loadMcpUser(db, 'other-1')
    if (!other) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      other,
      buildArtifactFile('# secret', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    const body = await callTool(db, 'list_comments', {
      id: published.id,
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('post_comment starts a new thread on an artifact you can view', async () => {
    const { id } = await publishOwnerDoc()

    const body = await callTool(db, 'post_comment', {
      id,
      body: 'Please tighten the intro',
    })
    expect(body.error).toBeUndefined()
    const content = postCommentContent(body)
    expect(content.reply).toBe(false)
    expect(content.thread_id).toBeTruthy()
    expect(content.thread?.status).toBe('open')
    expect(content.thread?.anchor?.kind).toBe('artifact')
    expect(content.thread?.messages?.[0]?.body).toBe('Please tighten the intro')
    expect(content.thread?.messages?.[0]?.author_email).toBe(
      'owner-1@example.com',
    )

    const listed = await callTool(db, 'list_comments', { id })
    const threads =
      (listed.result as { structuredContent?: { comments?: unknown[] } })
        .structuredContent?.comments ?? []
    expect(threads).toHaveLength(1)
  })

  test('post_comment replies to an existing thread', async () => {
    const { sessionUser, id } = await publishOwnerDoc()
    const access = await loadCommentAccess(db, sessionUser, id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(
      db,
      access,
      sessionUser,
      'First note',
    )
    if (created.kind !== 'ok') throw new Error('seed thread failed')

    const body = await callTool(db, 'post_comment', {
      id,
      body: 'Replying to the note',
      reply_to: created.threadId,
    })
    expect(body.error).toBeUndefined()
    const content = postCommentContent(body)
    expect(content.reply).toBe(true)
    expect(content.thread_id).toBe(created.threadId)
    expect(content.thread?.messages?.map((m) => m.body)).toEqual([
      'First note',
      'Replying to the note',
    ])
  })

  test('post_comment rejects a reply to an unknown thread', async () => {
    const { id } = await publishOwnerDoc()
    const body = await callTool(db, 'post_comment', {
      id,
      body: 'hi',
      reply_to: 'no-such-thread',
    })
    expect(errorPayload(body).code).toBe('thread-not-found')
  })

  test('post_comment refuses a reply to a resolved thread', async () => {
    const { sessionUser, id } = await publishOwnerDoc()
    const access = await loadCommentAccess(db, sessionUser, id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(
      db,
      access,
      sessionUser,
      'To be resolved',
    )
    if (created.kind !== 'ok') throw new Error('seed thread failed')
    const resolved = await setCommentThreadResolved(
      db,
      access,
      sessionUser,
      created.threadId,
      true,
    )
    expect(resolved.kind).toBe('ok')

    const body = await callTool(db, 'post_comment', {
      id,
      body: 'late reply',
      reply_to: created.threadId,
    })
    expect(errorPayload(body).code).toBe('thread-resolved')
  })

  test('post_comment refuses an artifact you cannot view', async () => {
    await seedWorkspace(db, { id: 'ws-b', hd: 'other.com' })
    await seedUser(db, { id: 'other-1', workspaceId: 'ws-b' })
    const other = await loadMcpUser(db, 'other-1')
    if (!other) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      other,
      buildArtifactFile('# secret', 'markdown'),
      'private',
      [],
      null,
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return

    const body = await callTool(db, 'post_comment', {
      id: published.id,
      body: 'sneaking a comment in',
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('post_comment anchors a comment to a quoted span', async () => {
    const source = '# Title\n\nThe quick brown fox jumps over the dog.'
    const { id } = await publishOwnerDoc(source)
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })
    const body = await callTool(db, 'post_comment', {
      id,
      body: 'tighten this',
      quote: 'quick brown fox',
    })
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        thread?: { anchor?: { kind?: string; quoted_text?: string } }
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.thread?.anchor?.kind).toBe('text')
    expect(result.structuredContent?.thread?.anchor?.quoted_text).toBe(
      'quick brown fox',
    )
    const anchors = await db
      .selectFrom('comment_anchors')
      .select('quoted_text')
      .execute()
    expect(anchors.map((a) => a.quoted_text)).toEqual(['quick brown fox'])
  })

  test('post_comment disambiguates a repeated quote with surrounding context', async () => {
    const source = '# Doc\n\nalpha target omega and later beta target gamma.'
    const { id } = await publishOwnerDoc(source)
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })
    const body = await callTool(db, 'post_comment', {
      id,
      body: 'here',
      quote: 'target',
      quote_before: 'beta ',
      quote_after: ' gamma',
    })
    expect((body.result as { isError?: boolean }).isError).toBeFalsy()
    const anchor = await db
      .selectFrom('comment_anchors')
      .select(['prefix_text', 'suffix_text'])
      .executeTakeFirstOrThrow()
    // The supplied context is stored, anchoring the second 'target', not the first.
    expect(anchor.prefix_text).toBe('beta')
    expect(anchor.suffix_text).toBe('gamma')
  })

  test('post_comment returns quote-not-found when the text is absent', async () => {
    const source = '# Doc\n\nNothing relevant here.'
    const { id } = await publishOwnerDoc(source)
    storageMock.getArtifact.mockResolvedValue({
      text: async () => source,
      size: source.length,
    })
    const body = await callTool(db, 'post_comment', {
      id,
      body: 'x',
      quote: 'a phrase that is not present',
    })
    expect(errorPayload(body).code).toBe('quote-not-found')
  })

  test('post_comment returns quote-unsupported for a multi-file site', async () => {
    const { id } = await publishOwnerDoc('# Doc\n\nbody')
    // Promote both the shareable and its version to a bundle kind, which has no
    // single anchorable text.
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'static_site' })
      .where('id', '=', id)
      .execute()
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'static_site' })
      .where('shareable_id', '=', id)
      .execute()

    const body = await callTool(db, 'post_comment', {
      id,
      body: 'x',
      quote: 'body',
    })
    expect(errorPayload(body).code).toBe('quote-unsupported')
  })

  test('post_comment rejects a quote combined with a reply', async () => {
    const { sessionUser, id } = await publishOwnerDoc('# Doc\n\nThe text here.')
    const access = await loadCommentAccess(db, sessionUser, id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(db, access, sessionUser, 'First')
    if (created.kind !== 'ok') throw new Error('seed thread failed')

    const body = await callTool(db, 'post_comment', {
      id,
      body: 'x',
      reply_to: created.threadId,
      quote: 'text',
    })
    expect(errorPayload(body).code).toBe('quote-on-reply')
  })

  // Seed a thread on owner-1's workspace-visible artifact, authored by `author`
  // (defaults to owner-1), and return the thread id, first message id, and the
  // artifact id the comment tools act on.
  async function seedThread(authorId = 'owner-1', body = 'Needs a look') {
    const { id } = await publishOwnerDoc()
    const author = await loadMcpUser(db, authorId)
    if (!author) throw new Error('seed failed')
    const authorSession = mcpUserAsSessionUser(author)
    const access = await loadCommentAccess(db, authorSession, id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(db, access, authorSession, body)
    if (created.kind !== 'ok') throw new Error('seed thread failed')
    const message = await db
      .selectFrom('comment_messages')
      .select('id')
      .where('thread_id', '=', created.threadId)
      .executeTakeFirstOrThrow()
    return { artifactId: id, threadId: created.threadId, messageId: message.id }
  }

  test('resolve_comment resolves and reopen_comment reopens a thread', async () => {
    const { threadId } = await seedThread()
    const resolved = await callTool(db, 'resolve_comment', {
      thread_id: threadId,
    })
    const r1 = resolved.result as {
      isError?: boolean
      structuredContent?: { thread?: { status?: string } }
    }
    expect(r1.isError).toBeFalsy()
    expect(r1.structuredContent?.thread?.status).toBe('resolved')

    const reopened = await callTool(db, 'reopen_comment', {
      thread_id: threadId,
    })
    const r2 = reopened.result as {
      structuredContent?: { thread?: { status?: string } }
    }
    expect(r2.structuredContent?.thread?.status).toBe('open')
  })

  test('update_comment edits your own comment body', async () => {
    const { threadId, messageId } = await seedThread()
    const body = await callTool(db, 'update_comment', {
      thread_id: threadId,
      message_id: messageId,
      body: 'Edited text',
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { thread?: { messages?: Array<{ body?: string }> } }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.thread?.messages?.[0]?.body).toBe(
      'Edited text',
    )
    const row = await db
      .selectFrom('comment_messages')
      .select('body')
      .where('id', '=', messageId)
      .executeTakeFirst()
    expect(row?.body).toBe('Edited text')
  })

  test('update_comment forbids editing another member’s comment', async () => {
    await seedUser(db, { id: 'mate-4', workspaceId: 'ws-a' })
    const { threadId, messageId } = await seedThread('mate-4', 'Mate note')
    // owner-1 (the callTool identity) is the artifact owner but not the author,
    // so editing the body is refused even though they could resolve the thread.
    const body = await callTool(db, 'update_comment', {
      thread_id: threadId,
      message_id: messageId,
      body: 'Hijacked',
    })
    expect(errorPayload(body).code).toBe('forbidden')
    const row = await db
      .selectFrom('comment_messages')
      .select('body')
      .where('id', '=', messageId)
      .executeTakeFirst()
    expect(row?.body).toBe('Mate note')
  })

  test('resolve_comment reports not-found for an unknown thread', async () => {
    const body = await callTool(db, 'resolve_comment', {
      thread_id: 'no-such-thread',
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('delete_comment removes a single message and keeps the thread', async () => {
    const { artifactId, threadId, messageId } = await seedThread()
    // A second message so the thread survives the first message's deletion.
    await callTool(db, 'post_comment', {
      id: artifactId,
      body: 'second message',
      reply_to: threadId,
    })
    const body = await callTool(db, 'delete_comment', {
      thread_id: threadId,
      message_id: messageId,
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: {
        thread_deleted?: boolean
        thread?: { messages?: Array<{ body?: string }> }
      }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.thread_deleted).toBe(false)
    const bodies = result.structuredContent?.thread?.messages?.map(
      (m) => m.body,
    )
    expect(bodies).toEqual(['second message'])
    const rows = await db
      .selectFrom('comment_messages')
      .select('id')
      .where('id', '=', messageId)
      .execute()
    expect(rows).toEqual([])
  })

  test('delete_comment rejects a message from another thread', async () => {
    const { id } = await publishOwnerDoc()
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const sessionUser = mcpUserAsSessionUser(user)
    const access = await loadCommentAccess(db, sessionUser, id)
    if (!access) throw new Error('expected comment access')
    const first = await createCommentThread(db, access, sessionUser, 'First')
    const second = await createCommentThread(db, access, sessionUser, 'Second')
    if (first.kind !== 'ok' || second.kind !== 'ok') {
      throw new Error('seed thread failed')
    }
    const secondMessage = await db
      .selectFrom('comment_messages')
      .select('id')
      .where('thread_id', '=', second.threadId)
      .executeTakeFirstOrThrow()

    const body = await callTool(db, 'delete_comment', {
      thread_id: first.threadId,
      message_id: secondMessage.id,
    })

    expect(errorPayload(body).code).toBe('message-not-found')
    const rows = await db
      .selectFrom('comment_messages')
      .select('id')
      .where('id', '=', secondMessage.id)
      .execute()
    expect(rows).toHaveLength(1)
  })

  test('delete_comment deletes a whole thread', async () => {
    const { threadId } = await seedThread()
    const body = await callTool(db, 'delete_comment', { thread_id: threadId })
    const result = body.result as {
      isError?: boolean
      structuredContent?: { thread_deleted?: boolean }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.thread_deleted).toBe(true)
    const rows = await db
      .selectFrom('comment_threads')
      .select('id')
      .where('id', '=', threadId)
      .execute()
    expect(rows).toEqual([])
  })

  test('delete_comment deleting the only message removes the thread', async () => {
    const { threadId, messageId } = await seedThread()
    const body = await callTool(db, 'delete_comment', {
      thread_id: threadId,
      message_id: messageId,
    })
    const result = body.result as {
      structuredContent?: { thread_deleted?: boolean }
    }
    expect(result.structuredContent?.thread_deleted).toBe(true)
    const rows = await db
      .selectFrom('comment_threads')
      .select('id')
      .where('id', '=', threadId)
      .execute()
    expect(rows).toEqual([])
  })

  test('delete_comment forbids a viewer from deleting another’s thread', async () => {
    await seedUser(db, { id: 'mate-5', workspaceId: 'ws-a' })
    const mate = await loadMcpUser(db, 'mate-5')
    if (!mate) throw new Error('seed failed')
    const mateSession = mcpUserAsSessionUser(mate)
    const published = await uploadShareable(
      db,
      mate,
      buildArtifactFile('# Mate doc', 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    const access = await loadCommentAccess(db, mateSession, published.id)
    if (!access) throw new Error('expected comment access')
    const created = await createCommentThread(
      db,
      access,
      mateSession,
      'Mate only',
    )
    if (created.kind !== 'ok') throw new Error('seed thread failed')

    // owner-1 can view the workspace artifact but is neither the author, the
    // artifact owner, nor an admin, so the delete is refused.
    const body = await callTool(db, 'delete_comment', {
      thread_id: created.threadId,
    })
    expect(errorPayload(body).code).toBe('forbidden')
    const rows = await db
      .selectFrom('comment_threads')
      .select('id')
      .where('id', '=', created.threadId)
      .execute()
    expect(rows).toHaveLength(1)
  })

  test('delete_comment reports not-found for an unknown thread', async () => {
    const body = await callTool(db, 'delete_comment', {
      thread_id: 'no-such-thread',
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  test('list_projects returns the workspace projects with their sharing scope', async () => {
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Marketing',
      description: 'Campaign drafts',
      baseVisibility: 'workspace',
    })
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Board deck',
      description: null,
      baseVisibility: 'private',
    })

    const body = await callTool(db, 'list_projects')
    expect(body.error).toBeUndefined()
    const byName = new Map(listProjects(body).map((p) => [p.name, p]))
    expect(byName.get('Marketing')?.base_visibility).toBe('workspace')
    // owner-1 has no locale, so the label falls back to the default (English).
    expect(byName.get('Marketing')?.base_visibility_label).toBe(
      'Everyone in this workspace',
    )
    expect(byName.get('Marketing')?.description).toBe('Campaign drafts')
    expect(byName.get('Marketing')?.file_count).toBe(0)
    expect(byName.get('Board deck')?.base_visibility).toBe('private')
    expect(byName.get('Board deck')?.base_visibility_label).toBe(
      'Project members only',
    )
    expect(byName.get('Board deck')?.description).toBeNull()
  })

  test('list_projects omits archived projects', async () => {
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Active',
      description: null,
      baseVisibility: 'workspace',
    })
    const archivedId = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Archived',
      description: null,
      baseVisibility: 'workspace',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: NOW })
      .where('id', '=', archivedId)
      .execute()

    const names = listProjects(await callTool(db, 'list_projects')).map(
      (p) => p.name,
    )
    expect(names).toEqual(['Active'])
  })

  test('list_projects does not list another workspace projects', async () => {
    await seedWorkspace(db, { id: 'ws-b', hd: 'other.com' })
    await seedUser(db, { id: 'other-1', workspaceId: 'ws-b' })
    await createTestProject(db, 'ws-b', 'other-1', {
      name: 'Their project',
      description: null,
      baseVisibility: 'workspace',
    })

    expect(listProjects(await callTool(db, 'list_projects'))).toEqual([])
  })

  test('list_projects returns an empty list when there are no projects', async () => {
    const body = await callTool(db, 'list_projects')
    expect(body.error).toBeUndefined()
    expect(listProjects(body)).toEqual([])
  })

  test('create_project creates a project and returns its id and scope', async () => {
    const body = await callTool(db, 'create_project', {
      name: 'Launch',
      description: 'Q3 launch artifacts',
    })
    const result = body.result as {
      isError?: boolean
      structuredContent?: ProjectEntry
    }
    expect(result.isError).toBeFalsy()
    const project = result.structuredContent ?? {}
    expect(project.name).toBe('Launch')
    expect(project.description).toBe('Q3 launch artifacts')
    // Defaults to workspace scope when base_visibility is omitted.
    expect(project.base_visibility).toBe('workspace')
    expect(project.base_visibility_label).toBe('Everyone in this workspace')
    expect(project.file_count).toBe(0)
    // The new project shows up in list_projects and accepts an artifact.
    const listed = listProjects(await callTool(db, 'list_projects')).map(
      (p) => p.id,
    )
    expect(listed).toContain(project.id)
  })

  test('create_project honors a private base_visibility', async () => {
    const body = await callTool(db, 'create_project', {
      name: 'Board deck',
      base_visibility: 'private',
    })
    const project =
      (body.result as { structuredContent?: ProjectEntry }).structuredContent ??
      {}
    expect(project.base_visibility).toBe('private')
    expect(project.description).toBeNull()
  })

  test('create_project rejects users denied by upload access', async () => {
    const { env } = await import('cloudflare:workers')
    ;(env as { FLAGS?: unknown }).FLAGS = { getBooleanValue: async () => false }
    try {
      const body = await callTool(db, 'create_project', { name: 'Blocked' })

      expect(errorPayload(body).code).toBe('upload-not-enabled')
      const projects = await db
        .selectFrom('artifact_containers')
        .select('id')
        .where('kind', '=', 'project')
        .execute()
      expect(projects).toEqual([])
    } finally {
      delete (env as { FLAGS?: unknown }).FLAGS
    }
  })

  test('create_project files a freshly published artifact under the new project', async () => {
    const project =
      (
        (await callTool(db, 'create_project', { name: 'Filing' })).result as {
          structuredContent?: ProjectEntry
        }
      ).structuredContent ?? {}
    const { id } = await publishOwnerDoc('# To be filed\n\nbody')
    const moved = await callTool(db, 'edit_artifact', {
      id,
      project_id: project.id,
    })
    expect((moved.result as { isError?: boolean }).isError).toBeFalsy()
    const row = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.container_id).toBe(project.id)
  })

  test('create_project rejects a blank name', async () => {
    const body = await callTool(db, 'create_project', { name: '   ' })
    expect(errorPayload(body).code).toBe('invalid-name')
  })

  test('create_project rejects an active name case-insensitively', async () => {
    await callTool(db, 'create_project', { name: 'Launch' })
    const body = await callTool(db, 'create_project', { name: 'LAUNCH' })
    expect(errorPayload(body).code).toBe('project-name-conflict')
  })

  type EditProjectContent = ProjectEntry & {
    archived?: boolean
    audience?: string[]
  }

  function editProjectContent(body: {
    result?: Record<string, unknown>
  }): EditProjectContent {
    const result = body.result as {
      isError?: boolean
      structuredContent?: EditProjectContent
    }
    expect(result.isError).toBeFalsy()
    return result.structuredContent ?? {}
  }

  test('edit_project renames, re-describes, and rescopes in one call', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Old name',
      description: 'old',
      baseVisibility: 'workspace',
    })
    const project = editProjectContent(
      await callTool(db, 'edit_project', {
        id,
        name: 'New name',
        description: 'new description',
        base_visibility: 'private',
      }),
    )
    expect(project.name).toBe('New name')
    expect(project.description).toBe('new description')
    expect(project.base_visibility).toBe('private')
    expect(project.base_visibility_label).toBe('Project members only')
    expect(project.archived).toBe(false)
    const row = await db
      .selectFrom('artifact_containers')
      .select(['name', 'description', 'base_visibility'])
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row).toMatchObject({
      name: 'New name',
      description: 'new description',
      base_visibility: 'private',
    })
  })

  test('edit_project leaves omitted fields unchanged', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Keep',
      description: 'keep me',
      baseVisibility: 'private',
    })
    const project = editProjectContent(
      await callTool(db, 'edit_project', { id, name: 'Renamed only' }),
    )
    expect(project.name).toBe('Renamed only')
    // description and scope are untouched because they were omitted.
    expect(project.description).toBe('keep me')
    expect(project.base_visibility).toBe('private')
  })

  test('edit_project reports validation failures with edit input wording', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Input wording',
      description: null,
      baseVisibility: 'workspace',
    })

    const body = await callTool(db, 'edit_project', { id, name: '   ' })
    expect(errorPayload(body)).toMatchObject({
      code: 'invalid-name',
      message: 'Project name or audience input is invalid.',
    })
  })

  test('edit_project rejects another active project name', async () => {
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Existing',
      description: null,
      baseVisibility: 'workspace',
    })
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Rename me',
      description: null,
      baseVisibility: 'workspace',
    })

    const body = await callTool(db, 'edit_project', {
      id,
      name: 'EXISTING',
    })
    expect(errorPayload(body).code).toBe('project-name-conflict')
  })

  test('edit_project adds and removes audience members', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Audience',
      description: null,
      baseVisibility: 'private',
    })
    const added = editProjectContent(
      await callTool(db, 'edit_project', {
        id,
        add_emails: ['a@example.com', 'b@example.com'],
      }),
    )
    expect(added.audience).toEqual(['a@example.com', 'b@example.com'])
    const removed = editProjectContent(
      await callTool(db, 'edit_project', {
        id,
        remove_emails: ['a@example.com'],
      }),
    )
    expect(removed.audience).toEqual(['b@example.com'])
  })

  test('edit_project archives a project and hides it from the active list', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'To archive',
      description: null,
      baseVisibility: 'workspace',
    })
    const project = editProjectContent(
      await callTool(db, 'edit_project', { id, archived: true }),
    )
    expect(project.archived).toBe(true)
    const names = listProjects(await callTool(db, 'list_projects')).map(
      (p) => p.name,
    )
    expect(names).not.toContain('To archive')
    const row = await db
      .selectFrom('artifact_containers')
      .select('archived_at')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.archived_at).not.toBeNull()
  })

  test('edit_project unarchives and edits a project in one call', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Dormant',
      description: null,
      baseVisibility: 'workspace',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: NOW })
      .where('id', '=', id)
      .execute()

    const project = editProjectContent(
      await callTool(db, 'edit_project', {
        id,
        archived: false,
        name: 'Revived',
      }),
    )
    expect(project.archived).toBe(false)
    expect(project.name).toBe('Revived')
    const names = listProjects(await callTool(db, 'list_projects')).map(
      (p) => p.name,
    )
    expect(names).toContain('Revived')
  })

  test('edit_project can replace a reused archived name while restoring', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Reusable',
      description: null,
      baseVisibility: 'workspace',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: NOW })
      .where('id', '=', id)
      .execute()
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Reusable',
      description: null,
      baseVisibility: 'workspace',
    })

    const project = editProjectContent(
      await callTool(db, 'edit_project', {
        id,
        archived: false,
        name: 'Replacement',
      }),
    )
    expect(project).toMatchObject({
      id,
      name: 'Replacement',
      archived: false,
    })
  })

  test('edit_project leaves an archived project unchanged on rename conflict', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Sleeping',
      description: null,
      baseVisibility: 'workspace',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: NOW })
      .where('id', '=', id)
      .execute()
    await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Active',
      description: null,
      baseVisibility: 'workspace',
    })

    const body = await callTool(db, 'edit_project', {
      id,
      archived: false,
      name: 'ACTIVE',
    })
    expect(errorPayload(body).code).toBe('project-name-conflict')
    const row = await db
      .selectFrom('artifact_containers')
      .select(['name', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row).toMatchObject({ name: 'Sleeping', archived_at: NOW })
  })

  test('edit_project refuses to edit an archived project without unarchiving', async () => {
    const id = await createTestProject(db, 'ws-a', 'owner-1', {
      name: 'Sleeping',
      description: null,
      baseVisibility: 'workspace',
    })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: NOW })
      .where('id', '=', id)
      .execute()

    const body = await callTool(db, 'edit_project', { id, name: 'Nope' })
    expect(errorPayload(body).code).toBe('project-archived')
    const row = await db
      .selectFrom('artifact_containers')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.name).toBe('Sleeping')
  })

  test('edit_project forbids a non-creator non-admin from editing', async () => {
    await seedUser(db, { id: 'mate-3', workspaceId: 'ws-a' })
    const id = await createTestProject(db, 'ws-a', 'mate-3', {
      name: 'Theirs',
      description: null,
      baseVisibility: 'workspace',
    })
    // owner-1 (the callTool identity) is neither the creator nor an admin.
    const body = await callTool(db, 'edit_project', { id, name: 'Hijack' })
    expect(errorPayload(body).code).toBe('forbidden')
    const row = await db
      .selectFrom('artifact_containers')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row?.name).toBe('Theirs')
  })

  test('edit_project reports not-found for an unknown project id', async () => {
    const body = await callTool(db, 'edit_project', {
      id: 'no-such-project',
      name: 'x',
    })
    expect(errorPayload(body).code).toBe('not-found')
  })

  const denyLimiter: RateLimiter = { limit: async () => ({ success: false }) }

  function errorPayload(body: { result?: Record<string, unknown> }): {
    code?: string
    message?: string
    recoverable_by?: string
  } {
    const result = body.result as {
      isError?: boolean
      content?: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      error?: { code?: string; message?: string; recoverable_by?: string }
    }
    return parsed.error ?? {}
  }

  // Publish a single workspace-visible doc owned by owner-1 (the callTool
  // identity), returning what the comment tests need to act on it.
  async function publishOwnerDoc(source = '# Doc\n\nbody') {
    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    const published = await uploadShareable(
      db,
      user,
      buildArtifactFile(source, 'markdown'),
      'workspace',
      [],
      null,
    )
    if (published.kind !== 'ok') throw new Error('publish failed')
    return { user, sessionUser: mcpUserAsSessionUser(user), id: published.id }
  }

  type PostCommentContent = {
    thread_id?: string
    reply?: boolean
    thread?: {
      status?: string
      anchor?: { kind?: string }
      messages?: Array<{ body?: string; author_email?: string }>
    }
  }

  function postCommentContent(body: {
    result?: Record<string, unknown>
  }): PostCommentContent {
    const result = body.result as {
      isError?: boolean
      structuredContent?: PostCommentContent
    }
    expect(result.isError).toBeFalsy()
    return result.structuredContent ?? {}
  }

  type ProjectEntry = {
    id?: string
    name?: string
    description?: string | null
    base_visibility?: string
    base_visibility_label?: string
    file_count?: number
  }

  function listProjects(body: {
    result?: Record<string, unknown>
  }): ProjectEntry[] {
    const result = body.result as {
      isError?: boolean
      structuredContent?: { projects?: ProjectEntry[] }
    }
    expect(result.isError).toBeFalsy()
    return result.structuredContent?.projects ?? []
  }

  test('a per-user rate limit blocks the call with an agent-recoverable error', async () => {
    const body = await callTool(
      db,
      'whoami',
      {},
      {
        perUser: denyLimiter,
        perWorkspace: null,
      },
    )
    expect(body.error).toBeUndefined()
    const error = errorPayload(body)
    expect(error.code).toBe('rate-limited')
    expect(error.recoverable_by).toBe('agent')
  })

  test('a per-workspace rate limit blocks publish before any artifact is created', async () => {
    const body = await callTool(
      db,
      'share_artifact',
      { content: '# blocked', visibility: 'private' },
      { perUser: null, perWorkspace: denyLimiter },
    )
    expect(errorPayload(body).code).toBe('rate-limited')

    const user = await loadMcpUser(db, 'owner-1')
    if (!user) throw new Error('seed failed')
    expect(await listOwnedShareables(db, user)).toHaveLength(0)
  })

  test('a limiter error fails open so a real call still succeeds', async () => {
    const throwing: RateLimiter = {
      limit: async () => {
        throw new Error('limiter down')
      },
    }
    const body = await callTool(
      db,
      'whoami',
      {},
      {
        perUser: throwing,
        perWorkspace: throwing,
      },
    )
    expect(body.error).toBeUndefined()
    const result = body.result as {
      isError?: boolean
      structuredContent?: { connected?: boolean }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.connected).toBe(true)
  })

  test('a personal account cannot publish to the whole company', async () => {
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await seedUser(db, { id: 'solo-1', workspaceId: 'ws-personal' })
    const user = await loadMcpUser(db, 'solo-1')
    if (!user) throw new Error('seed failed')

    expect(defaultVisibilityFor(isOrgWorkspace(user))).toBe('private')
    const result = await uploadShareable(
      db,
      user,
      buildArtifactFile('<p>x</p>', 'html'),
      'workspace',
      [],
      null,
    )
    expect(result.kind).toBe('workspace-unavailable')
  })
})
