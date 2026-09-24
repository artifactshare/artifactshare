import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import {
  CLI_REFERENCE_ENTRY_POINT,
  cliReferenceContent,
} from '~/lib/cli-reference-content'
import surface from '~/lib/cli-reference-surface.generated.json'

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
vi.mock('./guide-shell', () => ({
  GuideHomeLink: ({ homeLabel }: { homeLabel: string }) => (
    <span>{homeLabel}</span>
  ),
  GuideMain: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  GuideProse: ({ children }: { children: ReactNode }) => (
    <article>{children}</article>
  ),
  GuideShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  GuideTopbar: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('./guide-language-switcher', () => ({
  GuideLanguageSwitcher: () => null,
}))
vi.mock('./guide-toc', () => ({
  GuideRail: () => null,
  GuideTocMobile: () => null,
}))
vi.mock('./copyable-code-block', () => ({
  CopyableCodeBlock: ({ children }: { children: ReactNode }) => (
    <pre>{children}</pre>
  ),
}))
vi.mock('~/components/layout/stack', () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { CliReferencePage } from './cli-reference-page'

describe.each(['en', 'ja'] as const)('CliReferencePage (%s)', (locale) => {
  test('renders version and generated date from the generated JSON surface', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    expect(html).toContain(`@artifactshare/cli ${surface.package_version}`)
    expect(html).toContain(surface.generated_date)
  })
  test('keeps every option intact with literal separators outside the spans', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    const lists = [
      CLI_REFERENCE_ENTRY_POINT.options,
      ...cliReferenceContent(locale).commands.map(
        ({ path }) =>
          surface.commands.find((command) => command.path === path)!.options,
      ),
    ]
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((match) => match[1])
      .filter((paragraph) => paragraph.includes('class="whitespace-nowrap"'))
    expect(paragraphs).toHaveLength(lists.length)
    lists.forEach((options, index) => {
      expect(paragraphs[index]).toBe(
        options
          .map((option) =>
            renderToStaticMarkup(
              <span className="whitespace-nowrap">{option}</span>,
            ),
          )
          .join(' · '),
      )
      expect(paragraphs[index].replace(/<[^>]+>/g, '')).toBe(
        options.join(' · '),
      )
    })
  })
})
