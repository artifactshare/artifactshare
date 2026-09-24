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
  test('keeps flags in the update role unbreakable without changing the text', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    const role = html.match(/<h3[^>]*>update<\/h3><p[^>]*>([\s\S]*?)<\/p>/)![1]
    expect(role).toContain(
      '<span class="whitespace-nowrap">--expected-version</span>',
    )
    expect(role.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Invalid, invisible-only, or repeated --label values fail locally with validation_failed before authentication.'
        : '--label の値が不正、不可視文字のみ、または指定が重複している場合は、認証前にローカルで validation_failed エラーになります。',
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
        ? 'For expected_version_required after login --preset agent, pass data.version.id from the previous successful share or update output as --expected-version when retrying update or share --key. If that output is unavailable, for single-file HTML and Markdown artifacts, artifacts get &lt;target&gt; --json returns the current version as data.version_id. For static sites, download &lt;target&gt; --json returns it as data.version.id. Check the returned current content (data.content, or the downloaded files for static sites) and reapply your changes to it if it differs from what you edited. Pass the returned value as --expected-version.'
        : 'login --preset agent でログインして expected_version_required が返された場合は、前回成功した share または update の出力にある data.version.id を --expected-version に指定して、update または share --key を再実行します。前回の出力がない場合、単一ファイルの HTML・Markdown では artifacts get &lt;target&gt; --json が現在のバージョンを data.version_id として返します。静的サイトでは download &lt;target&gt; --json が data.version.id として返します。返された現在の内容（data.content、静的サイトではダウンロードしたファイル）を確認し、編集元の内容と異なる場合は、その現在の内容に変更を適用し直します。返された値を --expected-version に指定します。',
    )
    expect(html).toContain('--expected-version &lt;version-id&gt;')
    const shareRole = html.match(
      /<h3[^>]*>share<\/h3><p[^>]*>([\s\S]*?)<\/p>/,
    )![1]
    expect(shareRole.replace(/<[^>]+>/g, '')).toBe(
      locale === 'en'
        ? 'Share a local file, folder, or static site. Profiles logged in with login --preset agent must also pass --expected-version when republishing with --key (see Failures and recovery).'
        : 'ローカルのファイル、フォルダ、静的サイトを共有します。login --preset agent でログインしたプロファイルでは、--key で再公開する際に --expected-version の指定も必要です（「失敗と復旧」を参照）。',
    )
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Upload a new version behind an existing share URL. Profiles logged in with login --preset agent must also pass --expected-version (see Failures and recovery).'
        : '既存の共有 URL の背後に新しい版をアップロードします。login --preset agent でログインしたプロファイルでは --expected-version の指定も必要です（「失敗と復旧」を参照）。',
    )
  },
)
