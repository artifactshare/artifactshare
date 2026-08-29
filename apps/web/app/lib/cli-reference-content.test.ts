import { describe, expect, test } from 'vitest'
import surface from './cli-reference-surface.generated.json'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_OUTPUT_SCHEMA_VERSION,
  CLI_REFERENCE_PUBLIC_COMMANDS,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceUsage,
  cliReferenceContent,
} from './cli-reference-content'

describe('CLI reference content', () => {
  test('covers every generated public command in both locales', () => {
    expect(surface.schema_version).toBe(2)
    expect(surface.package_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(surface.generated_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(surface.commands).toHaveLength(51)
    expect(CLI_REFERENCE_ENTRY_POINT.path).toBe('')
    expect(CLI_REFERENCE_PUBLIC_COMMANDS).toHaveLength(50)
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
      expect(content.commands).toHaveLength(50)
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
