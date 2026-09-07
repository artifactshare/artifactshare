import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }))

import { LinkAbuseJudgmentWorkflow } from './link-abuse-judgment-workflow'

describe('LinkAbuseJudgmentWorkflow', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('loads, extracts, judges, records, and emits the alert marker', async () => {
    const inserted: unknown[][] = []
    const prepare = vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.startsWith('SELECT visibility')) {
            return { visibility: 'link' }
          }
          if (!sql.includes('FROM shareables')) return null
          return {
            shareable_id: 'abc123def4',
            workspace_id: 'ws-1',
            r2_key: 'artifacts/abc123def4/v1/index.html',
            owner_created_at: '2026-08-01T00:00:00.000Z',
            workspace_plan: 'plus',
            visibility: 'link',
            version_status: 'published',
          }
        },
        run: async () => {
          inserted.push(values)
          return { success: true }
        },
      }),
    }))
    const aiRun = vi.fn(async () => ({
      response: JSON.stringify({
        risk: 'high',
        reason: 'fake_download',
        impersonatedBrand: 'ChatGPT',
        externalTargets: ['download.example.test'],
      }),
    }))
    const workflow = Object.create(
      LinkAbuseJudgmentWorkflow.prototype,
    ) as LinkAbuseJudgmentWorkflow
    Object.assign(workflow, {
      env: {
        DB: { prepare },
        BUCKET: {
          get: vi.fn(async () => ({
            text: async () =>
              '<style>hidden</style><h1>ChatGPT update</h1><a href="https://download.example.test/file">Download</a>',
          })),
        },
        AI: { run: aiRun },
        LINK_ABUSE_JUDGMENT_PROVIDER: 'workers-ai',
      },
    })
    const names: string[] = []
    const step = {
      do: vi.fn(async (name: string, callback: () => Promise<unknown>) => {
        names.push(name)
        return await callback()
      }),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await workflow.run(
      {
        payload: {
          shareableId: 'abc123def4',
          kind: 'automatic',
          trigger: 'ad_click',
          detail: 'gclid',
          expiresAt: '2026-09-06T06:00:00.000Z',
        },
        timestamp: new Date('2026-09-06T00:00:00.000Z'),
        instanceId: 'workflow-1',
        workflowName: 'artifactshare-link-abuse-judgment',
      } as never,
      step as never,
    )

    expect(result).toMatchObject({ kind: 'judged', risk: 'high' })
    expect(names).toEqual([
      'load shareable context',
      'extract entrypoint content',
      're-check link visibility',
      'judge link abuse risk',
      'record and announce judgment',
    ])
    expect(aiRun).toHaveBeenCalledWith(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining('"accountAgeDays":36'),
          }),
        ]),
      }),
    )
    expect(inserted).toHaveLength(1)
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO link_abuse_judgments'),
    )
    expect(inserted[0]).toEqual(
      expect.arrayContaining([
        'workflow-1',
        'abc123def4',
        'ad_click',
        'high',
        'fake_download',
        'ChatGPT',
        '["download.example.test"]',
        'workers-ai',
      ]),
    )
    expect(warn).toHaveBeenCalledWith('artifactshare_link_abuse_judgment', {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      trigger: 'ad_click',
      risk: 'high',
      reason: 'fake_download',
      impersonatedBrand: 'ChatGPT',
      externalTargets: ['download.example.test'],
      manageUrl: 'https://artifactshare.com/a/abc123def4',
      actionUrl: null,
    })
    // Announce only: the judgment never writes to shareables.
    expect(
      prepare.mock.calls.some(([sql]) => /UPDATE\s+shareables/iu.test(sql)),
    ).toBe(false)
  })

  test.each([
    {
      name: 'non-link visibility',
      context: { visibility: 'private', version_status: 'published' },
      reason: 'visibility_not_link',
    },
    {
      name: 'unpublished version',
      context: { visibility: 'link', version_status: 'draft' },
      reason: 'version_not_published',
    },
  ])(
    'skips $name without inference or a record',
    async ({ context, reason }) => {
      const run = vi.fn()
      const aiRun = vi.fn()
      const workflow = workflowWith({
        first: (sql) =>
          sql.includes('FROM shareables')
            ? {
                shareable_id: 'abc123def4',
                workspace_id: 'ws-1',
                r2_key: 'artifact.html',
                owner_created_at: '2026-08-01T00:00:00.000Z',
                workspace_plan: 'plus',
                ...context,
              }
            : null,
        run,
        aiRun,
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await expect(runWorkflow(workflow)).resolves.toEqual({
        kind: 'skipped',
        reason,
      })
      expect(aiRun).not.toHaveBeenCalled()
      expect(run).toHaveBeenCalledTimes(1)
      expect(workflow.prepareMock).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE link_abuse_judgment_gates'),
      )
      expect(workflow.prepareMock).toHaveBeenCalledWith(
        expect.stringContaining('AND expires_at = ?'),
      )
      expect(workflow.bindMock).toHaveBeenCalledWith(
        expect.any(String),
        'abc123def4',
        'manual',
        '2026-09-06T00:05:00.000Z',
      )
      expect(warn).toHaveBeenCalledWith('link_abuse_judgment_skipped', {
        shareableId: 'abc123def4',
        reason,
      })
    },
  )

  test('skips when the R2 entrypoint is missing', async () => {
    const run = vi.fn()
    const aiRun = vi.fn()
    const workflow = workflowWith({
      first: (sql) =>
        sql.startsWith('SELECT visibility')
          ? { visibility: 'link' }
          : publishedContext(),
      run,
      aiRun,
      object: null,
    })
    await expect(runWorkflow(workflow)).resolves.toEqual({
      kind: 'skipped',
      reason: 'entrypoint_missing',
    })
    expect(aiRun).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(workflow.prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE link_abuse_judgment_gates'),
    )
    expect(workflow.bindMock).toHaveBeenCalledWith(
      expect.any(String),
      'abc123def4',
      'manual',
      '2026-09-06T00:05:00.000Z',
    )
  })

  test('skips a missing shareable context without retrying', async () => {
    const run = vi.fn()
    const aiRun = vi.fn()
    const workflow = workflowWith({ first: () => null, run, aiRun })
    await expect(runWorkflow(workflow)).resolves.toEqual({
      kind: 'skipped',
      reason: 'shareable_not_found',
    })
    expect(aiRun).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(workflow.bindMock).toHaveBeenCalledWith(
      expect.any(String),
      'abc123def4',
      'manual',
      '2026-09-06T00:05:00.000Z',
    )
  })

  test('re-checks visibility immediately before inference and skips a change', async () => {
    const run = vi.fn()
    const aiRun = vi.fn()
    const workflow = workflowWith({
      first: (sql) =>
        sql.startsWith('SELECT visibility')
          ? { visibility: 'private' }
          : publishedContext(),
      run,
      aiRun,
    })
    await expect(runWorkflow(workflow)).resolves.toEqual({
      kind: 'skipped',
      reason: 'visibility_changed',
    })
    expect(aiRun).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(workflow.prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE link_abuse_judgment_gates'),
    )
    expect(workflow.bindMock).toHaveBeenCalledWith(
      expect.any(String),
      'abc123def4',
      'manual',
      '2026-09-06T00:05:00.000Z',
    )
  })

  test('skips the gate release when the payload predates gate tracking', async () => {
    const run = vi.fn()
    const workflow = workflowWith({ first: () => null, run, aiRun: vi.fn() })
    await expect(
      runWorkflow(workflow, { expiresAt: undefined }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'shareable_not_found' })
    expect(run).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE link_abuse_judgment_gates'),
      expect.anything(),
    )
  })

  test('leaves a gate refreshed by a newer trigger untouched', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T00:01:00.000Z'))
    let gateExpiry = '2026-09-06T01:00:00.000Z'
    const run = vi.fn((sql: string, values: unknown[]) => {
      if (
        sql.includes('UPDATE link_abuse_judgment_gates') &&
        gateExpiry === values[3]
      ) {
        gateExpiry = String(values[0])
      }
    })
    const workflow = workflowWith({ first: () => null, run, aiRun: vi.fn() })

    await expect(runWorkflow(workflow)).resolves.toEqual({
      kind: 'skipped',
      reason: 'shareable_not_found',
    })
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('AND expires_at = ?'),
      [
        '2026-09-06T00:02:00.000Z',
        'abc123def4',
        'manual',
        '2026-09-06T00:05:00.000Z',
      ],
    )
    expect(gateExpiry).toBe('2026-09-06T01:00:00.000Z')
  })

  test('keeps the gate when provider inference fails', async () => {
    const run = vi.fn()
    const workflow = workflowWith({
      first: (sql) =>
        sql.startsWith('SELECT visibility')
          ? { visibility: 'link' }
          : publishedContext(),
      run,
      aiRun: vi.fn().mockRejectedValue(new Error('provider failed')),
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(runWorkflow(workflow)).resolves.toMatchObject({
      kind: 'judged',
      risk: 'medium',
    })
    expect(workflow.prepareMock).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE link_abuse_judgment_gates'),
    )
  })
})

function publishedContext() {
  return {
    shareable_id: 'abc123def4',
    workspace_id: 'ws-1',
    r2_key: 'artifact.html',
    owner_created_at: '2026-08-01T00:00:00.000Z',
    workspace_plan: 'plus',
    visibility: 'link',
    version_status: 'published',
  }
}

function workflowWith(options: {
  first: (sql: string) => unknown
  run: (sql: string, values: unknown[]) => unknown | Promise<unknown>
  aiRun: ReturnType<typeof vi.fn>
  object?: { text: () => Promise<string> } | null
}) {
  const workflow = Object.create(
    LinkAbuseJudgmentWorkflow.prototype,
  ) as LinkAbuseJudgmentWorkflow
  const bind = vi.fn()
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      bind(...values)
      return {
        first: async () => options.first(sql),
        run: async () => await options.run(sql, values),
      }
    },
  }))
  Object.assign(workflow, {
    env: {
      DB: { prepare },
      BUCKET: {
        get: vi.fn(async () =>
          options.object === undefined
            ? { text: async () => '<h1>Artifact</h1>' }
            : options.object,
        ),
      },
      AI: { run: options.aiRun },
      LINK_ABUSE_JUDGMENT_PROVIDER: 'workers-ai',
    },
  })
  return Object.assign(workflow, { prepareMock: prepare, bindMock: bind })
}

function runWorkflow(
  workflow: LinkAbuseJudgmentWorkflow,
  overrides: { expiresAt?: string } = {},
) {
  return workflow.run(
    {
      payload: {
        shareableId: 'abc123def4',
        kind: 'manual',
        trigger: 'manual',
        detail: 'owner_requested',
        expiresAt: '2026-09-06T00:05:00.000Z',
        ...overrides,
      },
      timestamp: new Date('2026-09-06T00:00:00.000Z'),
      instanceId: 'workflow-1',
      workflowName: 'artifactshare-link-abuse-judgment',
    } as never,
    {
      do: async (_name: string, callback: () => Promise<unknown>) =>
        await callback(),
    } as never,
  )
}
