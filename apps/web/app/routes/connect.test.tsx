import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock('~/components/app/guide-shell', () => ({
  GuideHomeLink: ({ homeLabel }: { homeLabel: string }) => (
    <span>{homeLabel}</span>
  ),
  GuideMain: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  GuideShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  GuideTopbar: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('~/components/app/guide-toc', () => ({
  GuideRail: () => null,
  GuideTocMobile: () => null,
}))
vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: () => <footer />,
}))
vi.mock('~/components/app/copyable-code-block', () => ({
  CopyableCodeBlock: ({ children }: { children: ReactNode }) => (
    <pre>{children}</pre>
  ),
}))
vi.mock('~/components/app/connector-url-copy', () => ({
  ConnectorUrlCopy: ({ url }: { url: string }) => <code>{url}</code>,
}))
vi.mock('~/components/layout/inline', () => ({
  Inline: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('~/components/layout/stack', () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('~/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

import { ConnectPage } from './connect'

describe('/connect', () => {
  test('renders freshness and structured ChatGPT plan paths in English', () => {
    const html = renderToStaticMarkup(<ConnectPage locale="en" />)
    expect(html).toContain('Last verified: 2026-07-18 · Target UI: ChatGPT Web')
    expect(html).toContain(
      'ChatGPT MCP apps work only on ChatGPT Web and are not supported on mobile.',
    )
    expect(html).toContain('Business: Workspace admins and owners')
    expect(html).toContain('Enterprise / Edu: Authorized users')
    expect(html).toContain('https://artifactshare.com/mcp')
    expect(html).toContain('<ul')
  })

  test('keeps the approved Japanese ChatGPT copy', () => {
    const html = renderToStaticMarkup(<ConnectPage locale="ja" />)
    expect(html).toContain('最終確認日: 2026-07-18 · 対象 UI: ChatGPT Web')
    expect(html).toContain(
      'ChatGPT の MCP アプリは ChatGPT Web でのみ動作し、モバイルには対応していません。',
    )
    expect(html).toContain('プランと権限に合う入口へ進みます。')
    expect(html).toContain(
      'MCP server endpoint にこの MCP サーバ URL を設定します。',
    )
  })
})
