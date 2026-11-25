import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceContent,
  cliReferenceUsage,
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
  CopyableCodeBlock: ({ code, wrap }: { code: string; wrap?: boolean }) => (
    <pre data-wrap={wrap}>{code}</pre>
  ),
}))
vi.mock('~/components/layout/stack', () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { CliReferencePage } from './cli-reference-page'

describe.each(['en', 'ja'] as const)('CliReferencePage (%s)', (locale) => {
  test('renders interrupted-update cleanup guidance', () => {
    const html = renderToStaticMarkup(
      <CliReferencePage locale={locale} />,
    ).replace(/<[^>]*>/g, '')
    expect(html).toContain(
      locale === 'en'
        ? 'Updates without --dry-run remove temporary files left by an interrupted CLI update; --dry-run leaves them untouched.'
        : '--dry-run 以外の更新では途中で止まった更新の一時ファイルを削除しますが、--dry-run では削除しません。',
    )
  })

  test('renders one usage block per command and every example verbatim', () => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    const commands = cliReferenceContent(locale).commands
    const usages = [
      cliReferenceUsage(
        CLI_REFERENCE_ENTRY_POINT.path,
        CLI_REFERENCE_ENTRY_POINT.usage,
      ),
      ...commands.map(({ path }) =>
        cliReferenceUsage(
          path,
          surface.commands.find((command) => command.path === path)!.usage,
        ),
      ),
    ]
    const nodes = [
      ...html.matchAll(/<code class="([^"]*)">([\s\S]*?)<\/code>/g),
    ]
    expect(nodes).toHaveLength(commands.length + 1)
    nodes.forEach((node, index) => {
      expect(node[2].replace(/<[^>]+>/g, '')).toBe(
        renderToStaticMarkup(<>{usages[index]}</>),
      )
    })
    const examples = commands.filter((command) => command.example)
    const blocks = [
      ...html.matchAll(/<pre data-wrap="true">([\s\S]*?)<\/pre>/g),
    ]
    expect(blocks).toHaveLength(examples.length)
    blocks.forEach((block, index) => {
      expect(block[1]).toBe(
        renderToStaticMarkup(<>{examples[index].example}</>),
      )
    })
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
      const paragraphs = [...sectionHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      const texts = Array.isArray(section.body) ? section.body : [section.body]
      if (id === 'recovery') expect(paragraphs).toHaveLength(9)
      for (const [index, text] of texts.entries()) {
        const body = paragraphs[index][1]
        expect(body.replace(/<[^>]+>/g, '')).toBe(
          renderToStaticMarkup(<>{text}</>),
        )
        for (const flag of text.match(/--[\w-]+/g) ?? []) {
          expect(body).toContain(
            `<span class="whitespace-nowrap">${flag}</span>`,
          )
        }
      }
      if (locale === 'en') expect(html).not.toContain('Config-mode')
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
    const paragraphs = [
      ...html.matchAll(
        /<p\b[^>]*data-cli-option-list="true"[^>]*>([\s\S]*?)<\/p>/g,
      ),
    ].map((match) => match[1])
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
        : '--label が空・制御文字を含む・不正・不可視文字のみ・重複指定のいずれかだと、認証前にローカルで validation_failed になります。',
    )
    expect(role.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Successful JSON includes the stored label at data.version.label, or null when omitted. data.version.number matches the Viewer version number (v{number}); older servers may omit it.'
        : '成功時の JSON では data.version.label に保存されたラベル（省略時は null）、data.version.number に共有ページのバージョン番号（v{number}）が返ります（古いサーバーでは省略される場合があります）。',
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
        : 'login --preset agent で expected_version_required が返ったときは、前回成功した share / update 出力の data.version.id を --expected-version に渡して再実行してください。前回の出力がない場合は、単一 HTML / Markdown なら artifacts get &lt;target&gt; --json の data.version_id、静的サイトなら download &lt;target&gt; --json の data.version.id を取得し、現在の内容（data.content またはダウンロードしたファイル）が編集元と違っていれば変更を適用し直したうえで --expected-version に指定します。',
    )
    expect(html).toContain('--expected-version &lt;version-id&gt;')
    const shareRole = html.match(
      /<h3[^>]*>share<\/h3><p[^>]*>([\s\S]*?)<\/p>/,
    )![1]
    expect(shareRole.replace(/<[^>]+>/g, '')).toBe(
      locale === 'en'
        ? 'Share a local file (HTML, Markdown, PDF, or MP4 video up to 25 MiB; a .pdf must start with %PDF-, a .mp4 needs an ftyp box), folder, or static site. A share --key resend preserves visibility. If --visibility differs after normalization (at home, project compares as private), the command fails with key_visibility_mismatch before creating a version. Use edit &lt;id&gt; --visibility &lt;value&gt; --json to change it, and artifacts get &lt;id&gt; --json to check it for HTML and Markdown artifacts. Profiles logged in with login --preset agent must also pass --expected-version when republishing with --key (see Failures and recovery).'
        : 'ローカルのファイル（HTML、Markdown、25 MiB までの PDF・MP4 動画。.pdf は先頭が %PDF-、.mp4 は ftyp box を持つ必要があります）、フォルダ、静的サイトを共有します。share --key は既存の共有範囲を変更せず、home の project 指定は private として比較します。正規化後の --visibility が現在の値と違う場合は新しいバージョンを作らず key_visibility_mismatch で失敗するため、変更には edit &lt;id&gt; --visibility &lt;value&gt; --json、HTML・Markdown の共有範囲確認には artifacts get &lt;id&gt; --json を使います。login --preset agent のプロファイルで --key を使って再公開するときは、--expected-version の指定も必要です（「失敗と復旧」を参照）。',
    )
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      locale === 'en'
        ? 'Upload a new version behind an existing share URL. Profiles logged in with login --preset agent must also pass --expected-version (see Failures and recovery).'
        : '同じ共有リンクのまま新しいバージョンをアップロードします。login --preset agent でログインしたプロファイルでは --expected-version の指定が必要です（「失敗と復旧」を参照）。',
    )
  },
)

test.each(['en', 'ja'] as const)(
  'renders edit project visibility and managed retention help in %s',
  (locale) => {
    const html = renderToStaticMarkup(<CliReferencePage locale={locale} />)
    expect(html).toContain('private, workspace, project, or link')
    expect(html).toContain('project requires placement in a project')
    expect(html).toContain(
      locale === 'en'
        ? 'N or all (owner only). Keeps the latest N versions; publisher-managed artifacts count only publisher versions and keep all versions people added. Older eligible versions are permanently deleted; all clears the limit.'
        : 'N または all（所有者のみ）。最新の N バージョンを残します。publisher の資格情報で作成したファイルや publisher クライアントに割り当てたファイルでは、publisher が追加したバージョンだけを数え、人が追加したバージョンはすべて残します。削除された古いバージョンは元に戻せません。all で上限を解除します。',
    )
    const editCard = html.match(/<h3[^>]*>edit<\/h3>([\s\S]*?)<\/article>/)![1]
    expect(editCard).toContain(
      'data-cli-option-list="true" class="text-muted-foreground m-0 text-xs break-words"',
    )
    expect(editCard).toMatch(
      /<p class="text-muted-foreground mt-\[var\(--spacing-2\)\] mb-0 text-xs break-words">[^<]*<span[^>]*>--visibility<\/span>/,
    )
    expect(html).toContain(
      locale === 'en'
        ? 'requires the artifact to be in a project after the edit'
        : '編集後の保存先がプロジェクトである必要があり',
    )
  },
)
