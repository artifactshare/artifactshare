import { beforeEach, describe, expect, test, vi } from 'vitest'
import alerts from './alerts'

class MemoryKv {
  values = new Map<string, string>()
  failNextPut = false

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('kv put failed')
    }
    this.values.set(key, value)
  }
}

type TestEnv = Parameters<NonNullable<typeof alerts.tail>>[1]

function testEnv(): TestEnv {
  return {
    ALERT_STATE: new MemoryKv() as unknown as KVNamespace,
    APP_ENV: 'test',
    SLACK_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/C',
    LINK_OPS_ACTION_SECRET: 'ops-secret',
  }
}

function fetchTrace(
  status: number,
  url = 'https://artifactshare.com/a/abc',
  timestamp = '2026-07-04T00:00:00Z',
): TraceItem {
  return {
    event: {
      request: {
        method: 'GET',
        url,
        headers: {
          authorization: 'Bearer secret-token',
        },
        getUnredacted() {
          return this
        },
      },
      response: { status },
    },
    eventTimestamp: Date.parse(timestamp),
    logs: [],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: 'artifactshare',
    outcome: 'ok',
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 0,
    wallTime: 0,
  } as TraceItem
}

function scheduledTrace(outcome: string): TraceItem {
  return {
    ...fetchTrace(200),
    event: {
      cron: '0 17 * * *',
      scheduledTime: Date.parse('2026-07-04T17:00:00Z'),
    },
    outcome,
  } as TraceItem
}

function exceptionTrace(): TraceItem {
  return {
    ...fetchTrace(200, 'https://artifactshare.com/private?token=secret'),
    exceptions: [
      {
        timestamp: Date.parse('2026-07-04T00:00:00Z'),
        name: 'D1_ERROR',
        message: 'contains private@example.com and secret-token',
        stack: 'stack contains private@example.com',
      },
    ],
    outcome: 'exception',
  } as TraceItem
}

function failedFetchTrace(outcome: string): TraceItem {
  return {
    ...fetchTrace(200, 'https://artifactshare.com/private?token=secret'),
    event: {
      request: {
        method: 'GET',
        url: 'https://artifactshare.com/private?token=secret',
        headers: {
          authorization: 'Bearer secret-token',
        },
        getUnredacted() {
          return this
        },
      },
    },
    outcome,
  } as TraceItem
}

function sandboxReportTrace(detail: unknown): TraceItem {
  const trace = fetchTrace(
    200,
    'https://artifactshare.com/api/shareables/abc123def4/sandbox-block-report',
  )
  trace.logs.push({
    message: ['artifactshare_sandbox_block_report', detail],
    level: 'warn',
    timestamp: Date.parse('2026-07-04T00:00:00Z'),
  })
  return trace
}

function linkReportTrace(detail: unknown): TraceItem {
  const trace = fetchTrace(
    200,
    'https://abc123def4.artifactshare.link/api/shareables/abc123def4/report',
  )
  trace.logs.push({
    message: ['artifactshare_link_report', detail],
    level: 'warn',
    timestamp: Date.parse('2026-09-06T00:00:00Z'),
  })
  return trace
}

function workspaceMigrationWaitTrace(detail: unknown): TraceItem {
  const trace = scheduledTrace('ok')
  trace.logs.push({
    message: ['artifactshare_workspace_migration_wait', detail],
    level: 'warn',
    timestamp: Date.parse('2026-07-04T00:00:00Z'),
  })
  return trace
}

function linkAbuseJudgmentTrace(detail: unknown): TraceItem {
  const trace = fetchTrace(200, 'https://artifactshare.com/a/abc123def4')
  trace.logs.push({
    message: ['artifactshare_link_abuse_judgment', detail],
    level: 'warn',
    timestamp: Date.parse('2026-09-06T00:00:00Z'),
  })
  return trace
}

describe('alerts tail worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
  })

  test('sends one Slack alert when 5xx reaches the burst threshold', async () => {
    const env = testEnv()

    await alerts.tail?.(
      [
        fetchTrace(500),
        fetchTrace(502),
        fetchTrace(503),
        fetchTrace(504),
        fetchTrace(500),
      ],
      env,
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).text).toContain('5xx burst')
  })

  test('counts 5xx bursts across bucket boundaries', async () => {
    const env = testEnv()

    await alerts.tail?.(
      [
        fetchTrace(
          500,
          'https://artifactshare.com/a/abc',
          '2026-07-04T00:04:59Z',
        ),
        fetchTrace(
          500,
          'https://artifactshare.com/a/abc',
          '2026-07-04T00:04:59Z',
        ),
        fetchTrace(
          500,
          'https://artifactshare.com/a/abc',
          '2026-07-04T00:04:59Z',
        ),
        fetchTrace(
          500,
          'https://artifactshare.com/a/abc',
          '2026-07-04T00:04:59Z',
        ),
        fetchTrace(
          500,
          'https://artifactshare.com/a/abc',
          '2026-07-04T00:05:01Z',
        ),
      ],
      env,
    )

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('does not set success cooldown when Slack rejects an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('bad webhook', { status: 500 }))
        .mockResolvedValueOnce(new Response('ok')),
    )
    const env = testEnv()
    const state = env.ALERT_STATE as unknown as MemoryKv

    await alerts.tail?.(
      [
        fetchTrace(500),
        fetchTrace(500),
        fetchTrace(500),
        fetchTrace(500),
        fetchTrace(500),
      ],
      env,
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      [...state.values.keys()].some((key) => key.includes('/cooldown/')),
    ).toBe(false)

    for (const key of state.values.keys()) {
      if (key.includes('/slack-failure/')) state.values.delete(key)
    }
    await alerts.tail?.([fetchTrace(500)], env)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(
      [...state.values.keys()].some((key) => key.includes('/cooldown/')),
    ).toBe(true)
  })

  test('sends Slack alert for failed cron invocation', async () => {
    await alerts.tail?.([scheduledTrace('exception')], testEnv())

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).text).toContain('cron failed')
  })

  test('sends a PII-free alert for a new workspace migration wait', async () => {
    await alerts.tail?.(
      [
        workspaceMigrationWaitTrace({
          revision: 1,
        }),
      ],
      testEnv(),
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const payload = JSON.stringify(JSON.parse(String(init?.body)))
    expect(payload).toContain('workspace migration waiting')
    expect(payload).not.toMatch(/@|domain|workspace_id|user_id/u)
  })

  test('deduplicates one unresolved wait but alerts on a new generation', async () => {
    const env = testEnv()
    const first = workspaceMigrationWaitTrace({
      revision: 1,
    })

    await alerts.tail?.([first, first], env)
    await alerts.tail?.(
      [
        workspaceMigrationWaitTrace({
          revision: 2,
        }),
      ],
      env,
    )

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('ignores malformed workspace migration wait markers', async () => {
    await alerts.tail?.(
      [
        workspaceMigrationWaitTrace({
          revision: 'customer@example.com',
        }),
      ],
      testEnv(),
    )

    expect(fetch).not.toHaveBeenCalled()
  })

  test.each(['forbidden', 'network-error', 'timeout'])(
    'alerts on valid %s marker',
    async (failureType) => {
      await alerts.tail?.(
        [
          sandboxReportTrace({
            artifactId: 'abc123def4',
            failureType,
            confirmedAt: '2026-07-04T00:00:00.000Z',
          }),
        ],
        testEnv(),
      )
      expect(fetch).toHaveBeenCalledTimes(1)
      const body = JSON.stringify(
        JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)),
      )
      expect(body).toContain('abc123def4')
      expect(body).toContain(failureType)
      expect(body).toContain('2026-07-04T00:00:00.000Z')
      expect(body).not.toMatch(/query|header|token|email|user.?agent/i)
    },
  )

  test('ignores malformed marker and applies cooldown by artifact and failure', async () => {
    const env = testEnv()
    await alerts.tail?.(
      [
        sandboxReportTrace({
          artifactId: 'bad',
          failureType: 'timeout',
          confirmedAt: '2026-02-30T00:00:00.000Z',
        }),
      ],
      env,
    )
    expect(fetch).not.toHaveBeenCalled()
    const validTrace = sandboxReportTrace({
      artifactId: 'abc123def4',
      failureType: 'timeout',
      confirmedAt: '2026-07-04T00:00:00.000Z',
    })
    await alerts.tail?.([validTrace, validTrace], env)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('alerts immediately for a valid link report and cools down per artifact', async () => {
    const env = testEnv()
    const trace = linkReportTrace({
      shareableId: 'abc123def4',
      workspaceId: 'V1StGXR8_Z5jdHi6B-myT',
      reason: 'phishing',
      viewerUrl: 'https://abc123def4.artifactshare.link/',
    })

    await alerts.tail?.([trace, trace], env)

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.stringify(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)),
    )
    expect(body).toContain('link reported')
    expect(body).toContain('abc123def4')
    expect(body).toContain('phishing')
  })

  test.each([
    {
      shareableId: 'bad',
      workspaceId: 'V1StGXR8_Z5jdHi6B-myT',
      reason: 'phishing',
      viewerUrl: 'https://bad.artifactshare.link/',
    },
    {
      shareableId: 'abc123def4',
      workspaceId: 'V1StGXR8_Z5jdHi6B-myT',
      reason: 'spam',
      viewerUrl: 'https://abc123def4.artifactshare.link/',
    },
    {
      shareableId: 'abc123def4',
      workspaceId: 'V1StGXR8_Z5jdHi6B-myT',
      reason: 'malware',
      viewerUrl: 'https://evil.example/',
    },
  ])('ignores malformed link report markers', async (detail) => {
    await alerts.tail?.([linkReportTrace(detail)], testEnv())
    expect(fetch).not.toHaveBeenCalled()
  })

  test('alerts on a link abuse judgment with artifact and manage links', async () => {
    await alerts.tail?.(
      [
        linkAbuseJudgmentTrace({
          shareableId: 'abc123def4',
          workspaceId: 'ws-1',
          trigger: 'ad_click',
          risk: 'high',
          reason: 'fake_download',
          impersonatedBrand: 'ChatGPT',
          externalTargets: ['download.example.test'],
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          actionUrl: null,
        }),
      ],
      testEnv(),
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.stringify(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)),
    )
    expect(body).toContain('risk: high')
    expect(body).toContain('fake_download')
    expect(body).toContain('abc123def4.artifactshare.link')
    expect(body).toContain('artifactshare.com/a/abc123def4')
    expect(body).toContain('download.example.test')
    expect(body).toContain('visibility was not changed')
  })

  test('bounds link abuse alert block text and summarizes external targets', async () => {
    const targets = Array.from(
      { length: 50 },
      (_, index) => `host-${index}.example.test`,
    )
    await alerts.tail?.(
      [
        linkAbuseJudgmentTrace({
          shareableId: 'abc123def4',
          workspaceId: 'ws-1',
          trigger: 'manual',
          risk: 'medium',
          reason: '&'.repeat(500),
          impersonatedBrand: null,
          externalTargets: targets,
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          actionUrl: null,
        }),
      ],
      testEnv(),
    )

    const payload = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0][1]?.body),
    ) as { blocks: Array<{ text: { text: string } }> }
    const blockText = payload.blocks[0]?.text.text ?? ''
    expect(blockText.length).toBeLessThan(3_000)
    expect(blockText).toContain('host-9.example.test, +40 more')
    expect(blockText).not.toContain('host-10.example.test')
    expect(blockText).not.toContain('&amp;'.repeat(301))
  })

  test('truncates link abuse reasons at a code-point boundary before escaping', async () => {
    await alerts.tail?.(
      [
        linkAbuseJudgmentTrace({
          shareableId: 'abc123def4',
          workspaceId: 'ws-1',
          trigger: 'manual',
          risk: 'medium',
          reason: `${'&'.repeat(299)}😀tail`,
          impersonatedBrand: null,
          externalTargets: [],
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          actionUrl: null,
        }),
      ],
      testEnv(),
    )

    const body = String(vi.mocked(fetch).mock.calls[0][1]?.body)
    expect(body).toContain(`${'&amp;'.repeat(299)}😀`)
    expect(body).not.toContain('tail')
  })

  test('applies link abuse alert cooldown per shareable and ignores malformed markers', async () => {
    const env = testEnv()
    const detail = {
      shareableId: 'abc123def4',
      workspaceId: 'ws-1',
      trigger: 'manual',
      risk: 'medium',
      reason: 'judgment_failed',
      impersonatedBrand: null,
      externalTargets: [],
      manageUrl: 'https://artifactshare.com/a/abc123def4',
      actionUrl: null,
    }
    await alerts.tail?.(
      [
        linkAbuseJudgmentTrace({
          ...detail,
          manageUrl: 'https://evil.example/',
        }),
      ],
      env,
    )
    expect(fetch).not.toHaveBeenCalled()
    await alerts.tail?.(
      [linkAbuseJudgmentTrace(detail), linkAbuseJudgmentTrace(detail)],
      env,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('sends Slack alert for failed fetch outcome without a response', async () => {
    await alerts.tail?.([failedFetchTrace('exceededCpu')], testEnv())

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.stringify(JSON.parse(String(init?.body)))
    expect(body).toContain('request failed')
    expect(body).toContain('exceededCpu')
    expect(body).toContain('/private')
    expect(body).not.toContain('token=secret')
    expect(body).not.toContain('secret-token')
  })

  test('sends Slack alert when getSession hang recovery fires', async () => {
    const trace = fetchTrace(
      200,
      'https://artifactshare.com/api/shareables/abc/comments',
    )
    trace.logs.push({
      message: ['artifactshare_auth_hang', { recovered: true }],
      level: 'warn',
      timestamp: Date.parse('2026-07-05T00:00:00Z'),
    })

    await alerts.tail?.([trace], testEnv())

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.stringify(JSON.parse(String(init?.body)))
    expect(body).toContain('auth hang')
    expect(body).toContain('recovered: true')
  })

  test('keeps processing later events when one alert event fails', async () => {
    const env = testEnv()
    const state = env.ALERT_STATE as unknown as MemoryKv
    state.failNextPut = true

    await alerts.tail?.([fetchTrace(500), scheduledTrace('exception')], env)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body)).text).toContain('cron failed')
  })

  test('does not include query strings, headers, exception messages, or stacks', async () => {
    await alerts.tail?.([exceptionTrace()], testEnv())

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.stringify(JSON.parse(String(init?.body)))
    expect(body).toContain('D1_ERROR')
    expect(body).toContain('/private')
    expect(body).not.toContain('token=secret')
    expect(body).not.toContain('secret-token')
    expect(body).not.toContain('private@example.com')
    expect(body).not.toContain('stack contains')
  })

  test('skips Slack when webhook secret is missing', async () => {
    const env = testEnv()
    delete env.SLACK_ALERT_WEBHOOK_URL

    await alerts.tail?.([scheduledTrace('exception')], env)

    expect(fetch).not.toHaveBeenCalled()
  })
})

function linkSuspensionTrace(detail: unknown): TraceItem {
  const trace = fetchTrace(303, 'https://artifactshare.com/ops/link/abc123def4')
  trace.logs.push({
    message: ['artifactshare_link_suspension', detail],
    level: 'warn',
    timestamp: Date.parse('2026-09-07T00:00:00Z'),
  })
  return trace
}

describe('link suspension alerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
  })

  test('announces an operator pause, a resume, and an owner appeal', async () => {
    const workspaceId = 'w'.repeat(21)
    await alerts.tail?.(
      [
        linkSuspensionTrace({
          action: 'suspend',
          shareableId: 'abc123def4',
          workspaceId,
          actor: {
            kind: 'operator_credential',
            credentialId: 'credential-1234567890',
          },
          source: { kind: 'judgment', id: 'judgment-1' },
          notifications: { sent: 1, failed: 0, skipped: 0 },
        }),
      ],
      testEnv(),
    )
    await alerts.tail?.(
      [
        linkSuspensionTrace({
          action: 'resume',
          shareableId: 'abc123def4',
          workspaceId,
          ownerNotice: 'failed',
        }),
      ],
      testEnv(),
    )
    const appeal = fetchTrace(
      200,
      'https://artifactshare.com/api/shareables/abc123def4/appeal',
    )
    appeal.logs.push({
      message: [
        'artifactshare_link_appeal',
        {
          shareableId: 'abc123def4',
          workspaceId,
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          message: 'This is our internal report.',
          source: { kind: 'appeal', id: 'appeal-1' },
        },
      ],
      level: 'warn',
      timestamp: Date.parse('2026-09-07T00:00:00Z'),
    })
    await alerts.tail?.([appeal], testEnv())
    expect(fetch).toHaveBeenCalledTimes(3)
    const bodies = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => String(init?.body))
    expect(bodies[0]).toContain('link paused')
    expect(bodies[0]).toContain('owner email: sent 1, failed 0, skipped 0')
    expect(bodies[1]).toContain('link resumed')
    expect(bodies[1]).toContain('owner email: failed')
    expect(bodies[2]).toContain('link appeal')
    expect(bodies[2]).toContain('This is our internal report.')
    expect(bodies[2]).toContain('resume link sharing')
  })

  test('drops suspension and appeal logs with an unexpected shape', async () => {
    await alerts.tail?.(
      [
        linkSuspensionTrace({
          action: 'delete',
          shareableId: 'abc123def4',
          workspaceId: 'w'.repeat(21),
          ownerNotice: 'sent',
        }),
      ],
      testEnv(),
    )
    const appeal = fetchTrace(200, 'https://artifactshare.com/a/abc123def4')
    appeal.logs.push({
      message: [
        'artifactshare_link_appeal',
        {
          shareableId: 'abc123def4',
          workspaceId: 'w'.repeat(21),
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          message: 'x',
          actionUrl: 'https://evil.example/ops/link/abc123def4?token=abc',
        },
      ],
      level: 'warn',
      timestamp: Date.parse('2026-09-07T00:00:00Z'),
    })
    await alerts.tail?.([appeal], testEnv())
    expect(fetch).not.toHaveBeenCalled()
  })

  test('shows the signed operator link on a judgment when present', async () => {
    await alerts.tail?.(
      [
        linkAbuseJudgmentTrace({
          shareableId: 'abc123def4',
          workspaceId: 'ws-1',
          trigger: 'manual',
          risk: 'medium',
          reason: 'suspicious_form',
          impersonatedBrand: null,
          externalTargets: [],
          manageUrl: 'https://artifactshare.com/a/abc123def4',
          source: { kind: 'judgment', id: 'judgment-1' },
        }),
      ],
      testEnv(),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][1]?.body)).toContain(
      'pause or resume link sharing',
    )
  })
})
