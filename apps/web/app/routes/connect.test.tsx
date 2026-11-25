import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { expectLocalePair } from '~/test/locale-documents'

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

import {
  ConnectPage,
  connectMeta,
  loader,
  meta as routeMeta,
} from './_public/($locale)/connect'

describe('/connect', () => {
  test('resolves both stable URL locales through the locale-aware route', () => {
    expect(loader({ params: {} } as never)).toEqual({ locale: 'en' })
    expect(loader({ params: { locale: 'ja' } } as never)).toEqual({
      locale: 'ja',
    })
  })

  test('publishes paired canonical and social metadata for each locale', () => {
    const en = connectMeta('en')
    const ja = connectMeta('ja')
    expect(en).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/connect',
    })
    expect(ja).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/ja/connect',
    })
    for (const tags of [en, ja]) {
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/connect',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: 'https://artifactshare.com/ja/connect',
      })
      expect(tags).toContainEqual({
        property: 'og:image',
        content: expect.stringContaining('/connect/og-image'),
      })
      expect(tags).toContainEqual({
        name: 'twitter:card',
        content: 'summary_large_image',
      })
    }
  })

  test('route metadata uses the locale returned by its loader', () => {
    expect(routeMeta({ loaderData: { locale: 'en' } } as never)).toEqual(
      connectMeta('en'),
    )
    expect(routeMeta({ loaderData: { locale: 'ja' } } as never)).toEqual(
      connectMeta('ja'),
    )
  })

  test('renders the MCP endpoint and plan paths in each locale', () => {
    const en = renderToStaticMarkup(<ConnectPage locale="en" />)
    const ja = renderToStaticMarkup(<ConnectPage locale="ja" />)

    for (const html of [en, ja]) {
      expect(html).toContain('https://artifactshare.com/mcp')
      expect(html).toContain('<ul')
    }
    expectLocalePair(en, ja)
  })
})
