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
