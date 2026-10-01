import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_SECTION_IDS,
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
  test('renders browser conflict recovery and intentional force in the existing reference', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    for (const token of [
      'version_conflict',
      'read_target',
      '--expected-version',
      '--force',
      'force=true',
    ])
      expect(html).toContain(token)
    expect(html).toContain(
      locale === 'en'
        ? 'Browser-created current versions'
        : '現在の版がブラウザーで作られた場合',
    )
  })

  test('preserves section anchors and heading labels', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    expect([...html.matchAll(/<h2\b/g)]).toHaveLength(
      CLI_REFERENCE_SECTION_IDS.length + 1,
    )
    for (const id of CLI_REFERENCE_SECTION_IDS) {
      expect(html).toMatch(
        new RegExp(
          `<section[^>]*id="${id}"[^>]*aria-labelledby="${id}-heading"`,
        ),
      )
      expect(html).toContain(
        renderToStaticMarkup(
          <h2 id={`${id}-heading`}>
            {cliReferenceContent(locale).sections[id].title}
          </h2>,
        ),
      )
    }
    expect(html).toContain('aria-labelledby="token-guide-heading"')
    expect(html).toContain('<h2 id="token-guide-heading">')
  })

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
  test('keeps flags in the update role unbreakable without changing the text', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    const role = html.match(/<h3[^>]*>update<\/h3><p[^>]*>([\s\S]*?)<\/p>/)![1]
    expect(role).toContain(
      '<span class="whitespace-nowrap">--expected-version</span>',
    )
    expect(role.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Empty labels, control characters, and invalid, invisible-only, or repeated --label values fail locally with validation_failed before authentication.'
        : '--label の値が空、制御文字を含む、不正、不可視文字のみ、または指定が重複している場合は、認証前にローカルで validation_failed エラーになります。',
    )
    expect(role.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Successful JSON includes the stored label at data.version.label, or null when omitted. data.version.number matches the Viewer version number (v{number}); older servers may omit it.'
        : '成功時の JSON は data.version.label に保存されたラベルを返し、省略時は null を返します。data.version.number は Viewer の版番号（v{number}）と一致します。古いサーバーではこのフィールドが省略される場合があります。',
    )
    expect(role.replace(/<[^>]+>/g, '')).toBe(
      renderToStaticMarkup(
        <>
          {
            cliReferenceContent(locale).commands.find(
              ({ path }) => path === 'update',
            )!.role
          }
        </>,
      ),
    )
  })
})

test.each(['en', 'ja'] as const)(
  'renders agent update recovery in %s',
  (locale) => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'For expected_version_required after login --preset agent, use the same get → reapply → send workflow with the current version.'
        : 'login --preset agent で expected_version_required が返された場合も、最新のソースと版を取得し、変更を適用し直して --expected-version を指定します。',
    )
    expect(html).toContain('--expected-version &lt;version-id&gt;')
    const shareRole = html.match(
      /<h3[^>]*>share<\/h3><p[^>]*>([\s\S]*?)<\/p>/,
    )![1]
    expect(shareRole.replace(/<[^>]+>/g, '')).toBe(
      renderToStaticMarkup(
        <>
          {
            cliReferenceContent(locale).commands.find(
              ({ path }) => path === 'share',
            )!.role
          }
        </>,
      ),
    )
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Upload a new version behind an existing share URL. Protect browser edits with --expected-version, or deliberately overwrite with --force (mutually exclusive).'
        : '既存の共有 URL に新しい版をアップロードします。ブラウザーの編集を保護するため --expected-version、意図的な上書きなら --force を指定します（併用不可）。',
    )
  },
)
