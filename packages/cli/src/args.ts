import type { CommandContext, Command } from 'gunshi'
import { CLI_INVOCATION, COMMAND_NAMES, SUBCOMMANDS } from './constants.js'
import type { CliCommand, CliError, CliOptions, ParsedArgs } from './types.js'
import {
  validationError,
  invalidExpectedVersion,
  unknownOptionError,
} from './errors.js'
import { camelCase } from './shared.js'

export function parsedArgsFromContext(
  command: CliCommand,
  ctx: Readonly<CommandContext>,
): ParsedArgs {
  const options = optionsFromContext(ctx)
  if (command === 'edit') {
    for (const token of ctx.tokens) {
      if (token.kind !== 'option') continue
      const rawName = token.name ?? token.rawName?.replace(/^--?/, '')
      if (rawName === 'title' && options.title === undefined) {
        options.title = ''
      }
    }
  }
  if (command === 'projects edit') {
    for (const token of ctx.tokens) {
      if (token.kind !== 'option') continue
      const rawName = token.name ?? token.rawName?.replace(/^--?/, '')
      if (rawName === 'description' && options.description === undefined) {
        options.description = ''
      }
    }
  }
  return {
    command,
    options,
    positionals: ctx.positionals.slice(command.includes(' ') ? 2 : 1),
  }
}

function optionsFromContext(ctx: Readonly<CommandContext>): CliOptions {
  const options: CliOptions = {}
  for (const [key, value] of Object.entries(ctx.values)) {
    if (ctx.args[key]?.type === 'positional') continue
    if (value === undefined) continue
    if (
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    ) {
      options[key] = value
    }
  }
  return options
}

export type OptionDefinition = Pick<Command, 'args' | 'toKebab' | 'subCommands'>
type Option = { name: string; boolean: boolean; spelling?: string }
type Options = Map<string, Option>

export function optionMetadata(
  definition: OptionDefinition,
  root?: OptionDefinition,
): Options {
  const options: Options = new Map([
    ['--help', { name: 'help', boolean: true }],
    ['-h', { name: 'help', boolean: true }],
    ['--version', { name: 'version', boolean: true }],
    ['-v', { name: 'version', boolean: true }],
  ])
  for (const source of [root, definition]) {
    if (!source) continue
    for (const [name, schema] of Object.entries(source.args ?? {})) {
      if (schema.type === 'positional') continue
      const option: Option = { name, boolean: schema.type === 'boolean' }
      options.set(`--${name}`, option)
      const kebab = name.replace(
        /[A-Z]/g,
        (letter) => `-${letter.toLowerCase()}`,
      )
      if (source.toKebab || schema.toKebab) {
        option.spelling = `--${kebab}`
        options.set(`--${kebab}`, option)
      }
      if (schema.short) options.set(`-${schema.short}`, option)
      if (schema.negatable) options.set(`--no-${kebab}`, option)
    }
  }
  return options
}

export function createArgumentParser(catalog: Map<string, Options>) {
  const allOptions: Options = new Map(
    [...catalog.values()].flatMap((options) => [...options]),
  )
  const VALUE_FLAGS = new Set(
    [...allOptions]
      .filter(([, option]) => !option.boolean)
      .map(([name]) => name.slice(2)),
  )
  // A value that begins with '-' (a markdown bullet, '---', a negative number)
  // parses as a flag in the space-separated form, so join it into --name=value
  // before gunshi sees it. A next token that is itself a known flag stays
  // separate: `--body --json` is almost always a missing value, not a body of
  // '--json', and should keep failing validation.
  function joinLeadingDashValues(argv: string[]): string[] {
    const result: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] ?? ''
      if (arg === '--') {
        result.push(...argv.slice(i))
        break
      }
      const next = argv[i + 1]
      if (
        arg.startsWith('--') &&
        !arg.includes('=') &&
        VALUE_FLAGS.has(arg.slice(2)) &&
        next !== undefined &&
        next.startsWith('-') &&
        !isKnownFlagToken(next)
      ) {
        result.push(`${arg}=${next}`)
        i += 1
        continue
      }
      result.push(arg)
    }
    return result
  }

  function isKnownFlagToken(token: string): boolean {
    return token === '--' || allOptions.has(token.split('=')[0] ?? '')
  }

  function validateRawArgs(
    argv: string[],
    command?: CliCommand,
  ): CliError | null {
    const options = catalog.get(command ?? '') ?? catalog.get('')!
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] ?? ''
      if (arg === '--') break
      if (!arg.startsWith('-') || arg === '-') continue
      const eqIndex = arg.indexOf('=')
      const spelling = eqIndex === -1 ? arg : arg.slice(0, eqIndex)
      const artifactIdError = unsupportedShareArtifactId(
        spelling.replace(/^--?/, ''),
        command,
      )
      if (artifactIdError) return artifactIdError
      const option = options.get(spelling)
      if (!option) return unknownOptionError(spelling, [...options.keys()])
      if (option.boolean) {
        if (eqIndex !== -1)
          return validationError(
            `${spelling} does not accept a value.`,
            `Use ${spelling} without =value.`,
          )
        continue
      }
      const value = eqIndex === -1 ? argv[++i] : arg.slice(eqIndex + 1)
      if (
        value === undefined ||
        (eqIndex === -1 && isKnownFlagToken(value)) ||
        (value === '' && !allowsEmptyValue(option.name))
      ) {
        return validationError(
          `${spelling} requires a value.`,
          `Pass ${spelling} <value> and retry.`,
        )
      }
      if (option.name === 'expectedVersion') {
        const error = invalidExpectedVersion(value)
        if (error) return error
      }
    }
    return null
  }

  function unsupportedShareArtifactId(
    rawName: string,
    command?: CliCommand,
  ): CliError | null {
    if (
      command !== 'share' ||
      (rawName !== 'artifact-id' && rawName !== 'artifactId')
    ) {
      return null
    }
    return validationError(
      'Share does not accept --artifact-id.',
      `To keep an existing share URL, run ${CLI_INVOCATION} update <artifact-id-or-url> <path> --json. For repeat jobs, use share --key <key>.`,
    )
  }

  function allowsEmptyValue(rawName: string): boolean {
    return rawName === 'title' || rawName === 'description'
  }

  function commandNameFromArgv(argv: string[]): CliCommand | undefined {
    const found = findCommandCandidate(argv)
    const command = found?.command
    if (found && command !== undefined && SUBCOMMANDS[command]) {
      const sub = nextPositional(argv, found.index)
      if (sub !== undefined && SUBCOMMANDS[command].includes(sub)) {
        if (command === 'artifacts' && sub === 'delete') return 'delete'
        return `${command} ${sub}` as CliCommand
      }
    }
    return command !== undefined && COMMAND_NAMES.has(command as CliCommand)
      ? (command as CliCommand)
      : undefined
  }

  function firstCommandCandidate(argv: string[]): string | undefined {
    const found = findCommandCandidate(argv)
    return found?.command
  }

  function findCommandCandidate(
    argv: string[],
  ): { command: string; index: number } | undefined {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] ?? ''
      if (arg === '--') {
        const command = argv[i + 1]
        return command === undefined ? undefined : { command, index: i + 1 }
      }
      if (!arg.startsWith('-') || arg === '-') return { command: arg, index: i }
      const eqIndex = arg.indexOf('=')
      const rawName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex)
      if (eqIndex === -1 && VALUE_FLAGS.has(rawName)) i += 1
    }
    return undefined
  }

  function nextPositional(
    argv: string[],
    afterIndex: number,
  ): string | undefined {
    const index = nextPositionalIndex(argv, afterIndex)
    return index === undefined ? undefined : argv[index]
  }

  function nextPositionalIndex(
    argv: string[],
    afterIndex: number,
  ): number | undefined {
    for (let i = afterIndex + 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? ''
      if (arg === '--') return i + 1 < argv.length ? i + 1 : undefined
      if (!arg.startsWith('-') || arg === '-') return i
      const eqIndex = arg.indexOf('=')
      const rawName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex)
      if (eqIndex === -1 && VALUE_FLAGS.has(rawName)) i += 1
    }
    return undefined
  }

  // Commands whose bare form takes a positional instead of a subcommand name.
  // Gunshi always reads the first positional after a parent as a subcommand, so
  // the default subcommand is inserted before it. The scan uses the same value
  // flag skipping as command resolution, otherwise `--profile work preview x`
  // mistakes the flag value for the command.
  const DEFAULT_SUBCOMMANDS: Record<string, string> = { preview: 'start' }

  function insertDefaultSubcommand(argv: string[]): string[] {
    const found = findCommandCandidate(argv)
    if (!found) return argv
    const fallback = DEFAULT_SUBCOMMANDS[found.command]
    if (fallback === undefined) return argv
    const subIndex = nextPositionalIndex(argv, found.index)
    const sub = subIndex === undefined ? undefined : argv[subIndex]
    if (sub !== undefined && SUBCOMMANDS[found.command]?.includes(sub)) {
      return argv
    }
    // `preview --help` must keep listing the subcommands, and bare `preview`
    // must keep reporting that one is required, so only insert the default when
    // the parent actually received a positional to act on.
    if (sub === undefined) return argv
    return [
      ...argv.slice(0, found.index + 1),
      fallback,
      ...argv.slice(found.index + 1),
    ]
  }

  // Normalize supported camelCase spellings before Gunshi resolves values.
  // Values and positional arguments after -- must remain byte-for-byte intact.
  function normalizeOptionSpellings(argv: string[]): string[] {
    const options = catalog.get(commandNameFromArgv(argv) ?? '')!
    const result: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!
      if (arg === '--') {
        result.push(...argv.slice(i))
        break
      }
      const eqIndex = arg.indexOf('=')
      const option = options.get(eqIndex === -1 ? arg : arg.slice(0, eqIndex))
      if (!option) {
        result.push(arg)
        continue
      }
      const spelling =
        option.spelling ?? (eqIndex === -1 ? arg : arg.slice(0, eqIndex))
      result.push(
        eqIndex === -1 ? spelling : `${spelling}${arg.slice(eqIndex)}`,
      )
      if (!option.boolean && eqIndex === -1 && argv[i + 1] !== undefined)
        result.push(argv[++i]!)
    }
    return result
  }

  // Gunshi only dispatches to a nested subcommand when it directly follows the
  // parent, so the subcommand is hoisted to the front together with the parent;
  // otherwise a value flag before the command makes gunshi treat the subcommand
  // name as the flagged parent's positional and exit silently.
  function normalizeArgvForGunshi(
    argv: string[],
    commandCandidate: string | undefined,
  ): string[] {
    argv = normalizeOptionSpellings(argv)
    if (commandCandidate === undefined) return argv
    const found = findCommandCandidate(argv)
    if (!found) return argv
    const subIndex = SUBCOMMANDS[found.command]
      ? nextPositionalIndex(argv, found.index)
      : undefined
    const sub = subIndex === undefined ? undefined : argv[subIndex]
    const hoistSub =
      sub !== undefined && SUBCOMMANDS[found.command]?.includes(sub)
    if (found.index === 0 && (!hoistSub || subIndex === found.index + 1)) {
      return argv
    }
    const rest = argv.filter(
      (_, index) => index !== found.index && !(hoistSub && index === subIndex),
    )
    const head = argv[found.index] ?? commandCandidate
    return hoistSub && sub !== undefined
      ? [head, sub, ...rest]
      : [head, ...rest]
  }

  return {
    joinLeadingDashValues,
    validateRawArgs,
    commandNameFromArgv,
    firstCommandCandidate,
    insertDefaultSubcommand,
    normalizeArgvForGunshi,
  }
}
