import type { CommandContext } from 'gunshi'
import {
  BOOLEAN_FLAGS,
  CLI_INVOCATION,
  COMMAND_NAMES,
  SUBCOMMANDS,
  UPDATE_OPTION_KEYS,
  VALUE_FLAGS,
} from './constants.js'
import type { CliCommand, CliError, CliOptions, ParsedArgs } from './types.js'
import { validationError } from './errors.js'
import { camelCase } from './shared.js'

export function parsedArgsFromContext(
  command: CliCommand,
  ctx: Readonly<CommandContext>,
): ParsedArgs {
  const options = optionsFromContext(ctx)
  if (command === 'update') {
    for (const token of ctx.tokens) {
      if (token.kind !== 'option') continue
      const rawName = token.name ?? token.rawName?.replace(/^--?/, '')
      if (!rawName) continue
      const name = camelCase(rawName)
      if (options[name] === undefined && !UPDATE_OPTION_KEYS.has(name)) {
        options[name] = true
      }
    }
  }
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

// A value that begins with '-' (a markdown bullet, '---', a negative number)
// parses as a flag in the space-separated form, so join it into --name=value
// before gunshi sees it. A next token that is itself a known flag stays
// separate: `--body --json` is almost always a missing value, not a body of
// '--json', and should keep failing validation.
export function joinLeadingDashValues(argv: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
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
  if (token === '--') return true
  if (!token.startsWith('--')) return false
  const eqIndex = token.indexOf('=')
  const name = eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex)
  return (
    BOOLEAN_FLAGS.has(name) ||
    VALUE_FLAGS.has(name) ||
    name === 'help' ||
    name === 'version'
  )
}

export function validateRawArgs(
  argv: string[],
  command?: CliCommand,
): CliError | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('--')) continue
    const eqIndex = arg.indexOf('=')
    if (eqIndex === -1) {
      const rawName = arg.slice(2)
      const artifactIdError = unsupportedShareArtifactId(rawName, command)
      if (artifactIdError) return artifactIdError
      const next = argv[i + 1]
      if (
        VALUE_FLAGS.has(rawName) &&
        (next === undefined ||
          isKnownFlagToken(next) ||
          (next === '' && !allowsEmptyValue(rawName)))
      ) {
        return validationError(
          `--${rawName} requires a value.`,
          `Pass --${rawName} <value> and retry.`,
        )
      }
      continue
    }
    const rawName = arg.slice(2, eqIndex)
    const artifactIdError = unsupportedShareArtifactId(rawName, command)
    if (artifactIdError) return artifactIdError
    const value = arg.slice(eqIndex + 1)
    if (BOOLEAN_FLAGS.has(rawName)) {
      return validationError(
        `--${rawName} does not accept a value.`,
        `Use --${rawName} without =value.`,
      )
    }
    if (
      VALUE_FLAGS.has(rawName) &&
      value === '' &&
      !allowsEmptyValue(rawName)
    ) {
      return validationError(
        `--${rawName} requires a value.`,
        `Pass --${rawName} <value> and retry.`,
      )
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

export function commandNameFromArgv(argv: string[]): CliCommand | undefined {
  const found = findCommandCandidate(argv)
  const command = found?.command
  if (found && command !== undefined && SUBCOMMANDS[command]) {
    const sub = nextPositional(argv, found.index)
    if (sub !== undefined && SUBCOMMANDS[command].includes(sub)) {
      return `${command} ${sub}` as CliCommand
    }
  }
  return command !== undefined && COMMAND_NAMES.has(command as CliCommand)
    ? (command as CliCommand)
    : undefined
}

export function firstCommandCandidate(argv: string[]): string | undefined {
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
    if (!arg.startsWith('--')) return { command: arg, index: i }
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
    if (!arg.startsWith('--')) return i
    const eqIndex = arg.indexOf('=')
    const rawName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex)
    if (eqIndex === -1 && VALUE_FLAGS.has(rawName)) i += 1
  }
  return undefined
}

// Gunshi only dispatches to a nested subcommand when it directly follows the
// parent, so the subcommand is hoisted to the front together with the parent;
// otherwise a value flag before the command makes gunshi treat the subcommand
// name as the flagged parent's positional and exit silently.
export function normalizeArgvForGunshi(
  argv: string[],
  commandCandidate: string | undefined,
): string[] {
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
  return hoistSub && sub !== undefined ? [head, sub, ...rest] : [head, ...rest]
}
