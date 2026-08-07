import { UPDATE_OPTION_KEYS } from './constants.js'
import type { CliError, CliOptions } from './types.js'
import { cliError, validationError } from './errors.js'

export function arrayOption(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function parseOffsetOption(
  value: string | undefined,
): { value: string | undefined; error?: never } | { error: CliError } {
  if (value === undefined) return { value: undefined }
  if (!/^\d+$/.test(value)) {
    return {
      error: validationError(
        '--offset must be a non-negative integer.',
        'Retry with --offset set to next_offset from the previous response.',
      ),
    }
  }
  return { value }
}

export function parseIncludeOptions(
  value: string | string[] | undefined,
): { values: string[]; error?: never } | { error: CliError } {
  const values: string[] = []
  for (const raw of arrayOption(value)) {
    for (const item of raw.split(',')) {
      const trimmed = item.trim()
      if (!trimmed) continue
      if (trimmed !== 'versions' && trimmed !== 'comments') {
        return {
          error: validationError(
            `Unsupported include value: ${trimmed}`,
            'Use --include versions or --include comments.',
          ),
        }
      }
      values.push(trimmed)
    }
  }
  return { values: [...new Set(values)] }
}

export function hasProjectIdHomeConflict(options: CliOptions): boolean {
  return options.projectId !== undefined && Boolean(options.home)
}

export function unsupportedUpdateOption(options: CliOptions): string | null {
  for (const key of Object.keys(options)) {
    if (!UPDATE_OPTION_KEYS.has(key)) return kebabCase(key)
  }
  return null
}

export function resolveArtifactId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const sandboxMatch = url.hostname.match(/^([A-Za-z0-9]+)\.sandbox\./)
  if (sandboxMatch?.[1]) return sandboxMatch[1]

  const shareMatch = url.pathname.match(/^\/a\/([A-Za-z0-9]+)(?:\.data)?\/?$/)
  if (shareMatch?.[1]) return shareMatch[1]

  return null
}

const TARGET_COMMAND_LABELS = {
  append: 'Append',
  update: 'Update',
  open: 'Open',
  'artifacts get': 'Artifacts get',
  download: 'Download',
  'comments list': 'Comments list',
  'comments post': 'Comments post',
  'comments edit': 'Comments edit',
  'comments resolve': 'Comments resolve',
  'comments reopen': 'Comments reopen',
  'comments delete': 'Comments delete',
  move: 'Move',
  edit: 'Edit',
  delete: 'Delete',
} as const

export function targetResolutionError(
  input: string,
  command: keyof typeof TARGET_COMMAND_LABELS,
): CliError {
  const why = `${TARGET_COMMAND_LABELS[command]} only accepts an artifact ID, share URL, or sandbox URL.`
  return cliError({
    code: 'target_not_found',
    message: 'Artifact target could not be resolved.',
    why,
    hint: 'Retry with an artifact ID, /a/<id> share URL, or sandbox URL. If you only have a title, resolve it to an ID first.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
    details: { input },
  })
}

export function parseArtifactTarget(
  input: string | undefined,
  command: keyof typeof TARGET_COMMAND_LABELS,
  missingHint: string,
): { artifactId: string; error?: never } | { error: CliError } {
  if (!input) {
    return { error: validationError('Artifact is required.', missingHint) }
  }
  const artifactId = resolveArtifactId(input)
  if (!artifactId) return { error: targetResolutionError(input, command) }
  return { artifactId }
}

export function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_: string, char: string) =>
    char.toUpperCase(),
  )
}

export function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}
