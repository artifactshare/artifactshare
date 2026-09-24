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
  CopyableCodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
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
  test('keeps section body flags unbreakable without changing the text', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    for (const [id, section] of Object.entries(
      cliReferenceContent(locale).sections,
    )) {
      const sectionHtml = html.match(
        new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`),
      )![1]
      const body = sectionHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/)![1]
      expect(body.replace(/<[^>]+>/g, '')).toBe(
        renderToStaticMarkup(<>{section.body}</>),
      )
      for (const flag of section.body.match(/--[\w-]+/g) ?? []) {
        expect(body).toContain(`<span class="whitespace-nowrap">${flag}</span>`)
      }
    }
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
      .filter((paragraph) =>
        /^<span class="whitespace-nowrap">[^<]+<\/span>( · |$)/.test(paragraph),
      )
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

test.each(['en', 'ja'] as const)(
  'renders agent update recovery in %s',
  (locale) => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    expect(html).toContain(
      locale === 'en'
        ? 'For expected_version_required after login --preset agent, pass data.version.id from the previous successful share or update output as --expected-version when retrying update or share --key. If that output is unavailable, artifacts get &lt;target&gt; --json returns the current version as data.version_id; pass that value as --expected-version.'
        : 'login --preset agent でログインして expected_version_required が返された場合は、前回成功した share または update の出力にある data.version.id を --expected-version に指定して、update または share --key を再実行します。前回の出力がない場合は、artifacts get &lt;target&gt; --json が現在のバージョンを data.version_id として返すので、その値を --expected-version に指定します。',
    )
    expect(html).toContain('--expected-version &lt;version-id&gt;')
  },
)
