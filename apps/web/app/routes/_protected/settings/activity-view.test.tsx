import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('ja') }
})

import ActivityPage from './activity'
import type { AuditEventsPageResult } from '~/lib/team-management'

const TestActivityPage = ActivityPage as ComponentType<{
  loaderData: AuditEventsPageResult
}>

afterEach(() => {
  vi.useRealTimers()
})

describe('access request activity rows', () => {
  test('shows request correlation, snapshots, scope, and system attribution', () => {
    const html = renderActivity({
      events: [
        event('access_request.created', {
          actor: user('requester', 'Requester', 'requester@example.com'),
        }),
        event('access_request.email.succeeded'),
        event('access_request.approved', {
          actor: user('owner', 'Owner', 'owner@example.com'),
          detail: { resolutionScope: 'project' },
        }),
      ],
      total: 3,
      page: 1,
    })

    expect(html).toContain('閲覧リクエストを受け付け')
    expect(html).toContain('メールを送信')
    expect(html).toContain('閲覧リクエストを承認')
    expect(html).toContain('申請 req_demo')
    expect(html).toContain('Long roadmap.html')
    expect(html).toContain('Requester (requester@example.com)')
    expect(html).toContain('Owner · owner@example.com')
    expect(html).toContain('プロジェクト単位')
    expect(html).toContain('システム')
  })

  test('labels an old incomplete delivery as unknown without relabeling unrelated null actors', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T01:00:00.000Z'))
    const html = renderActivity({
      events: [
        event('access_request.slack.attempting'),
        {
          ...event('artifact.delete'),
          id: 'legacy',
          actor: null,
          detail: { name: 'Deleted artifact.html' },
        },
      ],
      total: 2,
      page: 1,
    })

    expect(html).toContain('Slack DM送信の結果不明')
    expect(html.match(/システム/g)).toHaveLength(3)
    expect(html).toContain('Deleted artifact.html')
    expect(html).toContain('—')
  })
})

function renderActivity(loaderData: AuditEventsPageResult): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TestActivityPage loaderData={loaderData} />
    </MemoryRouter>,
  )
}

function event(
  action: string,
  overrides: Partial<AuditEventsPageResult['events'][number]> = {},
): AuditEventsPageResult['events'][number] {
  const { detail, ...rest } = overrides
  return {
    id: `${action}-id`,
    action,
    createdAt: '2026-09-01T00:00:00.000Z',
    actor: null,
    subject: null,
    detail: {
      accessRequestId: 'req_demo_7n4x2k9p',
      artifactId: 'artifact',
      artifactTitle: 'Long roadmap.html',
      projectId: 'project',
      projectName: 'Planning',
      requesterId: 'requester',
      requesterName: 'Requester',
      requesterEmail: 'requester@example.com',
      handlerId: 'owner',
      handlerName: 'Owner',
      handlerEmail: 'owner@example.com',
      recipientEmail: 'owner@example.com',
      ...detail,
    },
    ...rest,
  }
}

function user(id: string, name: string, email: string) {
  return { id, name, email, image: null, kind: 'human' as const }
}
