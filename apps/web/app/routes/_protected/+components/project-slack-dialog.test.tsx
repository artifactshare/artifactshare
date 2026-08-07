import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: null as unknown }))

vi.mock('react-router', () => ({
  useFetcher: () => ({
    state: 'idle',
    data: state.data,
    load: vi.fn(),
    submit: vi.fn(),
  }),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'ja', t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('~/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { ProjectSlackDialog } from './project-slack-dialog'

const render = () =>
  renderToStaticMarkup(
    createElement(ProjectSlackDialog, {
      open: true,
      onOpenChange: vi.fn(),
      projectId: 'proj1',
    }),
  )

beforeEach(() => {
  state.data = null
})

describe('ProjectSlackDialog', () => {
  test('unconfigured state links to the Slack install route', () => {
    state.data = { current: null }
    const html = render()
    expect(html).toContain('project.slack.choose')
    expect(html).toContain('href="/projects/proj1/slack/install"')
  })

  test('configured state shows channel, active badge, and clear link', () => {
    state.data = {
      current: {
        channelName: 'general',
        teamName: 'Workspace',
        updatedBy: 'User',
        updatedAt: '2026-07-29T00:00:00Z',
      },
      channels: [],
      missingScope: false,
    }
    const html = render()
    expect(html).toContain('#general')
    expect(html).toContain('project.slack.active')
    expect(html).toContain('project.slack.clear')
    expect(html).toContain('Workspace')
    expect(html).toContain('project.slack.change')
  })
})
