import { describe, expect, test } from 'vitest'
import surface from './cli-reference-surface.generated.json'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_EXAMPLES,
  CLI_OUTPUT_SCHEMA_VERSION,
  CLI_REFERENCE_PUBLIC_COMMANDS,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceUsage,
  cliReferenceContent,
} from './cli-reference-content'

describe('CLI reference content', () => {
  test.each(['en', 'ja'] as const)(
    'documents token import for CI in the %s introduction',
    (locale) => {
      const content = cliReferenceContent(locale)
      expect(content.sections.introduction.body).toContain(
        'profiles import-token',
      )
      expect(content.sections.introduction.body).toContain('CI')
      expect(content.commands.map((command) => command.path)).toContain(
        'profiles import-token',
      )
    },
  )

  test.each(['en', 'ja'] as const)(
    'names the runnable init command in the %s introduction',
    (locale) => {
      const content = cliReferenceContent(locale)
      expect(content.sections.introduction.body).toContain(
        CLI_REFERENCE_EXAMPLES.init,
      )
      expect(content.sections.introduction.body).not.toMatch(
        /\babove\b|上記の init コマンド/i,
      )
      expect(
        CLI_REFERENCE_PUBLIC_COMMANDS.map((command) => command.path),
      ).toContain('init')
      expect(
        content.commands.find((command) => command.path === 'init')?.example,
      ).toBe(CLI_REFERENCE_EXAMPLES.init)
    },
  )

  test('covers every generated public command in both locales', () => {
    expect(surface.schema_version).toBe(2)
    expect(surface.package_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(surface.generated_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(surface.commands).toHaveLength(52)
    expect(CLI_REFERENCE_ENTRY_POINT.path).toBe('')
    expect(CLI_REFERENCE_PUBLIC_COMMANDS).toHaveLength(51)
    const paths = CLI_REFERENCE_PUBLIC_COMMANDS.map((command) => command.path)
    expect(
      cliReferenceContent('en').commands.map((command) => command.path),
    ).toEqual(paths)
    expect(
      cliReferenceContent('ja').commands.map((command) => command.path),
    ).toEqual(paths)
    expect(Object.keys(cliReferenceContent('en').sections)).toEqual(
      CLI_REFERENCE_SECTION_IDS,
    )
    expect(Object.keys(cliReferenceContent('ja').sections)).toEqual(
      CLI_REFERENCE_SECTION_IDS,
    )
  })

  test('keeps the public contract language in both locales', () => {
    expect(CLI_OUTPUT_SCHEMA_VERSION).toBe(2)
    for (const locale of ['en', 'ja'] as const) {
      const content = cliReferenceContent(locale)
      expect(content.sections['json-exit'].body).toContain('schema_version: 2')
      expect(content.sections['json-exit'].body).toMatch(/0.*1.*130/)
      expect(content.sections.destinations.body).toContain('home_audience')
      expect(content.sections.destinations.body).toContain(
        'default_artifact_visibility',
      )
      expect(content.sections.destinations.body).toContain(
        'default_project_visibility',
      )
      expect(content.sections.destinations.body).toContain('--grant-email')
      expect(content.sections.destinations.body).toContain('user')
      expect(content.sections.destinations.body).toContain('repository')
      expect(content.sections.destinations.body).toContain('--visibility')
      expect(content.sections.destinations.body).toContain('--scope effective')
      expect(
        content.commands.find((command) => command.path === 'artifacts delete')
          ?.role,
      ).toMatch(/Alias of delete|delete の別名/)
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).toContain(
        locale === 'en'
          ? 'Empty labels, control characters, and invalid, invisible-only, or repeated --label values fail locally with validation_failed before authentication.'
          : '--label の値が空、制御文字を含む、不正、不可視文字のみ、または指定が重複している場合は、認証前にローカルで validation_failed エラーになります。',
      )
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).toContain(
        locale === 'en'
          ? 'Successful JSON includes the stored label at data.version.label, or null when omitted.'
          : '成功時の JSON は data.version.label に保存されたラベルを返し、省略時は null を返します。',
      )
      expect(
        content.commands.find((command) => command.path === 'update')?.role,
      ).not.toContain(
        locale === 'en'
          ? 'empty labels and control characters are rejected before authentication'
          : '空の値や制御文字は認証前に拒否します',
      )
      expect(content.commands).toHaveLength(51)
      expect(content.commands.every((command) => command.role.trim())).toBe(
        true,
      )
      expect(
        content.commands.some(
          (command) =>
            command.role === `この command は ${command.path} を実行します。`,
        ),
      ).toBe(false)
    }
  })

  test('keeps representative examples aligned with the generated surface', () => {
    const commands = new Map(
      surface.commands.map((command) => [command.path, command]),
    )
    for (const example of cliReferenceContent('en').representativeExamples) {
      const binaryMarker = '-- artifactshare '
      const cliInvocation = example.slice(
        example.indexOf(binaryMarker) + binaryMarker.length,
      )
      const tokens =
        cliInvocation
          .match(/(?:[^\s']+|'[^']*')+/g)
          ?.map((token) => token.replace(/^'|'$/g, '')) ?? []
      let matched
      let path = ''
      for (let length = Math.min(3, tokens.length); length > 0; length -= 1) {
        const candidate = tokens.slice(0, length).join(' ')
        if (commands.has(candidate)) {
          path = candidate
          matched = commands.get(candidate)
          break
        }
      }
      expect(matched, example).toBeDefined()
      for (const token of tokens.slice(path.split(' ').length)) {
        const option = token.match(/^(--[a-z0-9][a-z0-9-]*)(?:=|$)/)?.[1]
        if (option) expect(matched?.options).toContain(option)
      }
    }
  })

  test('adds parent command context when help repeats the root usage', () => {
    expect(cliReferenceUsage('', CLI_REFERENCE_ENTRY_POINT.usage)).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare [COMMANDS] <OPTIONS>',
    )
    expect(
      cliReferenceUsage('artifacts', CLI_REFERENCE_ENTRY_POINT.usage),
    ).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts [COMMANDS] <OPTIONS>',
    )
    expect(
      cliReferenceUsage(
        'artifacts get',
        'artifactshare artifacts get <OPTIONS> <artifactIdOrUrl>',
      ),
    ).toBe(
      'npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <OPTIONS> <artifactIdOrUrl>',
    )
  })

  test('renders every public usage with an explicit package binary', () => {
    for (const command of surface.commands) {
      expect(cliReferenceUsage(command.path, command.usage)).toMatch(
        /^npm exec --yes --package=@artifactshare\/cli -- artifactshare\b/,
      )
    }
  })

  test('keeps the related links labeled in both locales', () => {
    expect(
      Object.values(cliReferenceContent('en').links).map((link) => link.label),
    ).toEqual([
      'Share with AI',
      'Connect',
      'Updates',
      'Private mobile design handoff',
      'npm package',
    ])
    expect(
      Object.values(cliReferenceContent('ja').links).map((link) => link.label),
    ).toEqual([
      'AI から Artifact Share を使う',
      '接続ガイド',
      '更新情報',
      'モバイル文書の安全な引き継ぎ',
      'npm package',
    ])
  })

  test('keeps destination resolution and setting boundaries explicit', () => {
    for (const locale of ['en', 'ja'] as const) {
      const body = cliReferenceContent(locale).sections.destinations.body
      const keys =
        locale === 'en'
          ? [
              'repository home_audience',
              'repository default_artifact_visibility',
              'user home_audience',
              'user default_artifact_visibility',
              'product default workspace',
            ]
          : [
              'repository の home_audience',
              'repository の default_artifact_visibility',
              'user の home_audience',
              'user の default_artifact_visibility',
              '製品既定 workspace',
            ]
      for (let index = 1; index < keys.length; index += 1) {
        expect(body.indexOf(keys[index - 1])).toBeLessThan(
          body.indexOf(keys[index]),
        )
      }
      expect(body).toContain('.artifactshare/config.json')
      expect(body).toContain('user config')
      expect(body).toContain('default_project_visibility')
      expect(body).toMatch(/independent|独立/)
      expect(body).toMatch(/does not implicitly change|暗黙に変更しません/)
      expect(body).toMatch(/personal safe default|個人の安全な既定値/)
      expect(body).toMatch(/policy agreed|合意した方針/)
      expect(body).toMatch(/one post|一回限り/)
      expect(body).toContain('--scope effective')
    }
  })
})

test('documents agent update recovery in both locales', () => {
  expect(cliReferenceContent('en').sections.recovery.body).toContain(
    'For expected_version_required after login --preset agent, use the same get → reapply → send workflow with the current version.',
  )
  expect(cliReferenceContent('ja').sections.recovery.body).toContain(
    'login --preset agent で expected_version_required が返された場合も、最新のソースと版を取得し、変更を適用し直して --expected-version を指定します。',
  )
  for (const locale of ['en', 'ja'] as const) {
    expect(
      cliReferenceContent(locale).representativeExamples.find((example) =>
        example.includes('artifactshare update '),
      ),
    ).toContain('--expected-version <version-id>')
  }
})

test.each(['en', 'ja'] as const)(
  'explains browser protection, force, and recovery in %s',
  (locale) => {
    const content = cliReferenceContent(locale)
    for (const token of [
      'version_conflict',
      'read_target',
      'artifacts get',
      'download',
      'data.version_id',
      'data.version.id',
      '--expected-version',
      '--force',
      'force=true',
    ])
      expect(content.sections.recovery.body).toContain(token)
    expect(content.sections.recovery.body).toMatch(
      locale === 'en' ? /Browser-created.*reapply/ : /ブラウザー.*適用し直し/,
    )
    expect(content.sections.recovery.body).toMatch(
      locale === 'en'
        ? /historical unknown.*existing no-base/
        : /作成経路が不明.*従来どおり/,
    )
    for (const path of ['update', 'share']) {
      expect(
        content.commands.find((command) => command.path === path)?.role,
      ).toContain('--force')
      expect(
        surface.commands.find((command) => command.path === path)?.options,
      ).toContain('--force')
    }
  },
)
