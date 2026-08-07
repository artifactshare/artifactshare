import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {},
}))

import { D1BackupWorkflow } from './d1-backup-workflow'

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('D1BackupWorkflow', () => {
  test('exports D1 and stores a gzip dump in R2', async () => {
    const put = vi.fn(async () => undefined)
    const workflow = Object.create(
      D1BackupWorkflow.prototype,
    ) as D1BackupWorkflow
    Object.assign(workflow, {
      env: {
        BACKUP_BUCKET: { put },
        D1_BACKUP_ACCOUNT_ID: 'account-1',
        D1_BACKUP_DATABASE_ID: 'database-1',
        D1_REST_API_TOKEN: 'token-1',
      },
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          status: 'active',
          at_bookmark: 'bookmark-1',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            status: 'complete',
            success: true,
            result: {
              signed_url: 'https://example.com/export.sql',
              filename: 'export.sql',
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('CREATE TABLE test (id TEXT);'))
    globalThis.fetch = fetchMock
    const step = {
      do: vi.fn(async (_name: string, configOrCallback, maybeCallback) => {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : maybeCallback
        return await callback({})
      }),
      sleep: vi.fn(async () => undefined),
    }

    const result = await workflow.run(
      {
        payload: {},
        timestamp: new Date('2026-05-22T18:30:00.000Z'),
        instanceId: 'instance-1',
        workflowName: 'artifactshare-d1-backup',
        schedule: {
          cron: '30 18 * * *',
          scheduledTime: Date.parse('2026-05-22T18:30:00.000Z'),
        },
      } as never,
      step as never,
    )

    expect(result).toEqual({
      backup_key:
        'd1/artifactshare/2026/05/22/artifactshare-20260522T183000Z.sql',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/database-1/export',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          output_format: 'polling',
          dump_options: {
            no_schema: false,
            no_data: false,
            tables: [],
          },
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/database-1/export',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          output_format: 'polling',
          dump_options: {
            no_schema: false,
            no_data: false,
            tables: [],
          },
          current_bookmark: 'bookmark-1',
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://example.com/export.sql',
    )
    expect(put).toHaveBeenCalledWith(
      'd1/artifactshare/2026/05/22/artifactshare-20260522T183000Z.sql',
      expect.any(ReadableStream),
      {
        httpMetadata: { contentType: 'application/sql' },
        customMetadata: {
          database_id: 'database-1',
          source_filename: 'export.sql',
        },
      },
    )
  })

  test('advances the polling bookmark until the D1 export is ready', async () => {
    const put = vi.fn(async () => undefined)
    const workflow = Object.create(
      D1BackupWorkflow.prototype,
    ) as D1BackupWorkflow
    Object.assign(workflow, {
      env: {
        BACKUP_BUCKET: { put },
        D1_BACKUP_ACCOUNT_ID: 'account-1',
        D1_BACKUP_DATABASE_ID: 'database-1',
        D1_REST_API_TOKEN: 'token-1',
      },
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          status: 'active',
          at_bookmark: 'bookmark-1',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          status: 'active',
          at_bookmark: 'bookmark-2',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            status: 'complete',
            success: true,
            result: {
              signed_url: 'https://example.com/export.sql',
              filename: 'export.sql',
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('CREATE TABLE test (id TEXT);'))
    globalThis.fetch = fetchMock
    const step = {
      do: vi.fn(async (_name: string, configOrCallback, maybeCallback) => {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : maybeCallback
        return await callback({})
      }),
      sleep: vi.fn(async () => undefined),
    }

    const result = await workflow.run(
      {
        payload: {},
        timestamp: new Date('2026-05-22T18:30:00.000Z'),
        instanceId: 'instance-1',
        workflowName: 'artifactshare-d1-backup',
      } as never,
      step as never,
    )

    expect(result).toEqual({
      backup_key:
        'd1/artifactshare/2026/05/22/artifactshare-20260522T183000Z.sql',
    })
    expect(put).toHaveBeenCalledWith(
      'd1/artifactshare/2026/05/22/artifactshare-20260522T183000Z.sql',
      expect.any(ReadableStream),
      expect.any(Object),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/database-1/export',
      expect.objectContaining({
        body: JSON.stringify({
          output_format: 'polling',
          dump_options: {
            no_schema: false,
            no_data: false,
            tables: [],
          },
          current_bookmark: 'bookmark-1',
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/database-1/export',
      expect.objectContaining({
        body: JSON.stringify({
          output_format: 'polling',
          dump_options: {
            no_schema: false,
            no_data: false,
            tables: [],
          },
          current_bookmark: 'bookmark-2',
        }),
      }),
    )
    expect(step.sleep).not.toHaveBeenCalled()
  })

  test('fails when D1 reports the export ended without a download URL', async () => {
    const workflow = Object.create(
      D1BackupWorkflow.prototype,
    ) as D1BackupWorkflow
    Object.assign(workflow, {
      env: {
        BACKUP_BUCKET: { put: vi.fn() },
        D1_BACKUP_ACCOUNT_ID: 'account-1',
        D1_BACKUP_DATABASE_ID: 'database-1',
        D1_REST_API_TOKEN: 'token-1',
      },
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            status: 'active',
            success: true,
            at_bookmark: 'bookmark-1',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            success: false,
            error: 'Not currently exporting anything.',
          },
        }),
      )
    globalThis.fetch = fetchMock
    const step = {
      do: vi.fn(async (_name: string, configOrCallback, maybeCallback) => {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : maybeCallback
        return await callback({})
      }),
      sleep: vi.fn(async () => undefined),
    }

    await expect(
      workflow.run(
        {
          payload: {},
          timestamp: new Date('2026-05-22T18:30:00.000Z'),
          instanceId: 'instance-1',
          workflowName: 'artifactshare-d1-backup',
        } as never,
        step as never,
      ),
    ).rejects.toThrow('D1 export API failed: Not currently exporting anything.')
    expect(step.sleep).not.toHaveBeenCalled()
  })

  test('notifies Slack when the backup workflow fails', async () => {
    const workflow = Object.create(
      D1BackupWorkflow.prototype,
    ) as D1BackupWorkflow
    Object.assign(workflow, {
      env: {
        BACKUP_BUCKET: { put: vi.fn() },
        D1_BACKUP_ACCOUNT_ID: 'account-1',
        D1_BACKUP_DATABASE_ID: 'database-1',
        D1_REST_API_TOKEN: 'token-1',
        SLACK_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/C',
      },
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: false,
          errors: [{ message: 'private@example.com secret-token' }],
        }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    globalThis.fetch = fetchMock
    const step = {
      do: vi.fn(async (_name: string, configOrCallback, maybeCallback) => {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : maybeCallback
        return await callback({})
      }),
      sleep: vi.fn(async () => undefined),
    }

    await expect(
      workflow.run(
        {
          payload: {},
          timestamp: new Date('2026-05-22T18:30:00.000Z'),
          instanceId: 'instance-1',
          workflowName: 'artifactshare-d1-backup',
          schedule: {
            cron: '30 18 * * *',
            scheduledTime: Date.parse('2026-05-22T18:30:00.000Z'),
          },
        } as never,
        step as never,
      ),
    ).rejects.toThrow('private@example.com secret-token')

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://hooks.slack.com/services/T/B/C',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.stringify(JSON.parse(String(init?.body)))
    expect(body).toContain('artifactshare-d1-backup')
    expect(body).toContain('Error')
    expect(body).not.toContain('private@example.com')
    expect(body).not.toContain('secret-token')
  })
})
