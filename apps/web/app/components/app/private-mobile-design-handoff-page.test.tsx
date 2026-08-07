// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const writeClipboardTextMock = vi.hoisted(() => vi.fn())

vi.mock('~/lib/clipboard', () => ({
  writeClipboardText: writeClipboardTextMock,
}))
vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<'a'> & { to?: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock('./guide-shell', () => ({
  GuideHomeLink: ({ homeLabel }: { homeLabel: string }) => (
    <span>{homeLabel}</span>
  ),
  GuideProse: ({ children, ...props }: React.ComponentProps<'div'>) => (
    <div {...props}>{children}</div>
  ),
  GuideShell: ({ children }: React.PropsWithChildren) => (
    <main>{children}</main>
  ),
  GuideTopbar: ({ children }: React.PropsWithChildren) => (
    <header>{children}</header>
  ),
}))
vi.mock('./guide-language-switcher', () => ({
  GuideLanguageSwitcher: ({
    locale,
    hrefFor,
  }: {
    locale: 'en' | 'ja'
    hrefFor: (locale: 'en' | 'ja') => string
  }) => <a href={hrefFor(locale === 'en' ? 'ja' : 'en')}>switch</a>,
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}))

import { PrivateMobileDesignHandoffPage } from './private-mobile-design-handoff-page'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('PrivateMobileDesignHandoffPage', () => {
  beforeEach(() => {
    writeClipboardTextMock.mockReset()
    document.body.innerHTML = ''
  })

  test.each([
    {
      locale: 'en' as const,
      label: 'Copy Markdown',
      failed: 'Copy failed',
      cliHref: '/guides/cli',
      updatesHref: '/updates',
      switchHref: '/ja/guides/private-mobile-design-handoff',
    },
    {
      locale: 'ja' as const,
      label: 'Markdown をコピー',
      failed: 'コピーできませんでした',
      cliHref: '/ja/guides/cli',
      updatesHref: '/ja/updates',
      switchHref: '/guides/private-mobile-design-handoff',
    },
  ])(
    'copies the raw $locale Markdown and keeps its locale links',
    async ({ locale, label, failed, cliHref, updatesHref, switchHref }) => {
      const source = `# ${locale} source\n\nA Markdown paragraph.`
      const container = document.createElement('div')
      const root = createRoot(container)
      writeClipboardTextMock.mockResolvedValue(true)

      await React.act(async () => {
        root.render(
          <PrivateMobileDesignHandoffPage
            locale={locale}
            source={source}
            html="<h1>Rendered HTML</h1>"
          />,
        )
      })

      const button = container.querySelector('button')
      expect(button?.textContent).toBe(label)
      expect(container.textContent).toContain('2026-07-21')
      expect(
        [...container.querySelectorAll('a')].map((link) =>
          link.getAttribute('href'),
        ),
      ).toContain(cliHref)
      expect(
        [...container.querySelectorAll('a')].map((link) =>
          link.getAttribute('href'),
        ),
      ).toContain(updatesHref)
      expect(
        [...container.querySelectorAll('a')].map((link) =>
          link.getAttribute('href'),
        ),
      ).toContain(switchHref)

      await React.act(async () => button?.click())
      expect(writeClipboardTextMock).toHaveBeenCalledWith(source)
      expect(writeClipboardTextMock).not.toHaveBeenCalledWith(
        expect.stringContaining('Rendered HTML'),
      )
      expect(writeClipboardTextMock).not.toHaveBeenCalledWith(
        expect.stringContaining(label),
      )
      expect(button?.textContent).toBe(
        locale === 'ja' ? 'コピーしました' : 'Copied',
      )

      writeClipboardTextMock.mockResolvedValue(false)
      await React.act(async () => button?.click())
      expect(button?.textContent).toBe(failed)

      writeClipboardTextMock.mockResolvedValue(true)
      await React.act(async () => button?.click())
      expect(button?.textContent).toBe(
        locale === 'ja' ? 'コピーしました' : 'Copied',
      )
      await React.act(async () => root.unmount())
    },
  )
})
