import { describe, expect, test } from 'vitest'
import surface from './cli-reference-surface.generated.json'
import {
  CLI_REFERENCE_ENTRY_POINT,
  CLI_REFERENCE_EXAMPLES,
  CLI_OUTPUT_SCHEMA_VERSION,
  CLI_REFERENCE_PUBLIC_COMMANDS,
  CLI_REFERENCE_SECTION_IDS,
  cliReferenceUsage,
  cliReferenceOptionHelp,
  cliReferenceContent,
} from './cli-reference-content'

// The page is generated from the CLI's own help snapshot. What a reader
// depends on is that every public command is there, that each usage line can
// be pasted into a shell, and that the codes and JSON fields an agent
// branches on are documented. The wording around them is copy.

const LOCALES = ['en', 'ja'] as const

// Codes and response fields the CLI contract exposes; an agent reads these
// out of the reference to recover from a failure.
const CONTRACT_TOKENS = [
  'schema_version: 2',
  'auth_required',
  'token_invalid',
  'self_upload_disabled',
  'validation_failed',
  'expected_version_required',
  'invalid_expected_version',
  'unknown_option',
  'unsupported_node_version',
  'upload_read_failed',
  'search_daily_limit_exceeded',
  'search_capacity_exceeded',
  'parent_traversal',
  'outside_cwd',
  'not_found',
  'unsupported_guarantee',
  'invalid_type',
  'git_exclude_warning',
  'data.version.id',
  'data.version_id',
  'data.version.label',
  'data.backup_paths',
  'details.path',
  'details.reason',
  'details.option',
  'details.errno',
  'error.details.retry_at',
  'recovery.kind: change_input',
  'recovery.kind: ask_human',
  'agent_recoverable: false',
  'requires_human: true',
  '22.19.0',
  '^[a-z0-9]{10}$',
]

describe('CLI reference content', () => {
  test('covers every generated public command in both locales', () => {
    expect(surface.schema_version).toBe(2)
    expect(surface.package_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(surface.generated_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(CLI_REFERENCE_ENTRY_POINT.path).toBe('')
    expect(CLI_REFERENCE_PUBLIC_COMMANDS).toHaveLength(
      surface.commands.length - 1,
    )
    const paths = CLI_REFERENCE_PUBLIC_COMMANDS.map((command) => command.path)
    for (const locale of LOCALES) {
      const content = cliReferenceContent(locale)
      expect(content.commands.map((command) => command.path)).toEqual(paths)
      expect(Object.keys(content.sections)).toEqual(CLI_REFERENCE_SECTION_IDS)
    }
  })

  test.each(LOCALES)('every %s command entry is usable', (locale) => {
    const content = cliReferenceContent(locale)
    for (const command of content.commands) {
      expect(command.role.trim()).not.toBe('')
      // The generator falls back to this shape when a role is missing.
      expect(command.role).not.toBe(
        `この command は ${command.path} を実行します。`,
      )
    }
    expect(
      content.commands.find((command) => command.path === 'init')?.example,
    ).toBe(CLI_REFERENCE_EXAMPLES.init)
    expect(content.sections.introduction.body.join(' ')).toContain(
      CLI_REFERENCE_EXAMPLES.init,
    )
  })

  test('both locales document the same structure', () => {
    const shape = (locale: (typeof LOCALES)[number]) => {
      const content = cliReferenceContent(locale)
      return {
        sections: Object.entries(content.sections).map(([id, section]) => [
          id,
          Array.isArray(section.body) ? section.body.length : 1,
        ]),
        links: Object.keys(content.links).sort(),
        examples: content.representativeExamples.length,
      }
    }
    expect(shape('ja')).toEqual(shape('en'))
  })

  test.each(LOCALES)('%s labels every link and heading it shows', (locale) => {
    const content = cliReferenceContent(locale)
    for (const link of Object.values(content.links)) {
      expect(link.label.trim()).not.toBe('')
      expect(link.href).toMatch(/^(\/|https:\/\/)/)
    }
    for (const label of [
      content.title,
      content.commandsHeading,
      content.commandUsageLabel,
      content.commandOptionsLabel,
      content.commandExampleLabel,
      content.og.title,
      content.og.description,
    ])
      expect(label.trim()).not.toBe('')
  })

  test.each(LOCALES)('%s documents the machine-readable contract', (locale) => {
    expect(CLI_OUTPUT_SCHEMA_VERSION).toBe(2)
    const content = JSON.stringify(cliReferenceContent(locale))
    for (const token of CONTRACT_TOKENS) expect(content).toContain(token)
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

  test('localizes option help only for the command it is scoped to', () => {
    const help = surface.commands
      .find((command) => command.path === 'edit')
      ?.option_help?.find((entry) => entry.startsWith('--retain-versions'))
    expect(help).toBeDefined()
    expect(cliReferenceOptionHelp('edit', help!, 'en')).toBe(help)
    expect(cliReferenceOptionHelp('edit', help!, 'ja')).not.toBe(help)
    expect(cliReferenceOptionHelp('share', help!, 'ja')).toBe(help)

    const untranslated = '--visibility <visibility> private or link'
    expect(cliReferenceOptionHelp('edit', untranslated, 'ja')).toBe(
      untranslated,
    )
  })
})
