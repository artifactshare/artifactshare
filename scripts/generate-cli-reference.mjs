import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = resolve(ROOT, 'packages/cli/dist/index.js')
const CLI_PACKAGE_PATH = resolve(ROOT, 'packages/cli/package.json')
const OUTPUT_PATH = resolve(
  ROOT,
  'apps/web/app/lib/cli-reference-surface.generated.json',
)
const CLI_PACKAGE_VERSION = JSON.parse(
  readFileSync(CLI_PACKAGE_PATH, 'utf8'),
).version
export const CLI_SURFACE_SCHEMA_VERSION = 2
export const CLI_REFERENCE_PACKAGE_VERSION = CLI_PACKAGE_VERSION
export const DOCUMENT_PATHS = [
  'packages/cli/README.md',
  'docs/reference/cli-command-catalog.md',
  'packages/cli/skills/artifactshare/SKILL.md',
  'packages/cli/skills/artifactshare/artifactshare.mdc',
  'apps/web/app/lib/cli-reference-content.ts',
]
export const CAPABILITY_MATRIX_PATH = resolve(
  ROOT,
  'apps/web/app/lib/cli-capability-matrix.json',
)
export const MCP_TOOLS_SOURCE_PATH = resolve(
  ROOT,
  'apps/web/app/services/mcp/tools.server.ts',
)
export const AGENT_SURFACE_SOURCE_PATH = resolve(
  ROOT,
  'apps/web/app/lib/agent-surface.ts',
)

export function executableCommandPaths(snapshot) {
  const parents = new Set(
    snapshot.commands
      .filter((command) => command.path)
      .filter((command) =>
        snapshot.commands.some((child) =>
          child.path.startsWith(`${command.path} `),
        ),
      )
      .map((command) => command.path),
  )
  return snapshot.commands
    .map((command) => command.path)
    .filter((path) => path && !parents.has(path))
}

export function mcpToolNames(source) {
  return [...source.matchAll(/registerTool\(\s*'([^']+)'/g)].map(
    (match) => match[1],
  )
}

export function agentSurfaceKeys(source) {
  const keys = []
  for (const name of ['AGENT_CAPABILITIES', 'AGENT_RESTRICTIONS']) {
    const body = source.match(
      new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`),
    )?.[1]
    if (!body) continue
    for (const match of body.matchAll(/'([^']+)'/g)) keys.push(match[1])
  }
  return keys
}

function mcpToolBlock(source, name) {
  const marker = `server.registerTool(\n    '${name}',`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const next = source.indexOf('\n  server.registerTool(', start + marker.length)
  return source.slice(start, next < 0 ? undefined : next)
}

function constObjectBlock(source, name) {
  const marker = `const ${name} = {`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const next = source.indexOf('\nconst ', start + marker.length)
  return source.slice(start, next < 0 ? undefined : next)
}

function objectAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return ''
  const start = source.indexOf('{', markerIndex + marker.length)
  if (start < 0) return ''
  let depth = 0
  let quote = null
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    if (character === '}' && --depth === 0)
      return source.slice(start + 1, index)
  }
  return ''
}

function objectFieldNames(source, marker) {
  const body = objectAfterMarker(source, marker)
  const matches = [...`\n${body}`.matchAll(/\n([ \t]*)([A-Za-z_]\w*)\s*:/g)]
  if (!matches.length) return []
  const minimumIndent = Math.min(...matches.map((match) => match[1].length))
  return matches
    .filter((match) => match[1].length === minimumIndent)
    .map((match) => match[2])
}

function schemaFieldNames(source, schemaName, seen = new Set()) {
  if (seen.has(schemaName)) return []
  seen.add(schemaName)
  const marker = `const ${schemaName} =`
  const start = source.indexOf(marker)
  if (start < 0) return []
  const next = source.indexOf('\nconst ', start + marker.length)
  const block = source.slice(start, next < 0 ? undefined : next)
  const value = block.slice(marker.length).trimStart()
  const alias = value.match(/^([A-Za-z_]\w*)/)?.[1]
  if (alias) return schemaFieldNames(source, alias, seen)
  const fields = [...block.matchAll(/^  ([A-Za-z_]\w*)\s*:/gm)].map(
    (match) => match[1],
  )
  const spreadFields = [...block.matchAll(/^  \.\.\.([A-Za-z_]\w*)/gm)].flatMap(
    (match) => schemaFieldNames(source, match[1], seen),
  )
  return [...spreadFields, ...fields]
}

function resolvedCells(matrix, row) {
  return Object.fromEntries(
    matrix.surfaces.map((surface) => [
      surface.id,
      row.surfaces?.[surface.id] ?? surface.default,
    ]),
  )
}

const CAPABILITY_SURFACES = [
  'cli_help',
  'cli_readme',
  'bundled_skill',
  'generated_snapshot',
  'agent_surface',
  'mcp_tools',
  'changelog',
  'public_updates',
]
const CLI_OWNER_CONTRACTS = [
  'cli_command',
  'cli_option',
  'cli_json',
  'cli_auth',
]
const MCP_OWNER_CONTRACTS = [
  'mcp_name',
  'mcp_description',
  'mcp_input',
  'mcp_output',
  'mcp_recovery',
]

function cellIdentifiers(cell) {
  return cell?.identifiers ?? (cell?.identifier ? [cell.identifier] : [])
}

export function validateCapabilityMatrix({
  matrix,
  snapshot,
  mcpSource,
  agentSource = '',
  readFile = (path) => readFileSync(resolve(ROOT, path), 'utf8'),
  cliHelp = () => null,
}) {
  const errors = []
  const rows = matrix?.capabilities ?? []
  const surfaceIds = matrix.surfaces?.map((surface) => surface.id) ?? []
  if (
    surfaceIds.length !== CAPABILITY_SURFACES.length ||
    CAPABILITY_SURFACES.some((surface) => !surfaceIds.includes(surface))
  )
    errors.push('capability matrix must declare the eight canonical surfaces')
  for (const surface of matrix.surfaces ?? []) {
    if (
      surface.default &&
      !['changelog', 'public_updates'].includes(surface.id)
    )
      errors.push(`${surface.id}: only release surfaces may define a default`)
  }
  const executable = executableCommandPaths(snapshot)
  const tools = mcpToolNames(mcpSource)
  const agentKeys = agentSurfaceKeys(agentSource)
  const commandRows = rows.flatMap((row) =>
    (row.cli_commands ?? []).map((identifier) => ({ ...row, identifier })),
  )
  const toolRows = rows.flatMap((row) =>
    (row.mcp_tools ?? []).map((identifier) => ({ ...row, identifier })),
  )
  const agentRows = rows.flatMap((row) =>
    (row.agent_surface_keys ?? []).map((identifier) => ({
      ...row,
      identifier,
    })),
  )
  const ids = new Map()
  for (const row of rows) {
    if (!row.id || ids.has(row.id))
      errors.push(`duplicate capability id: ${row.id || '<missing>'}`)
    ids.set(row.id, row)
    const cells = resolvedCells(matrix, row)
    for (const surface of matrix.surfaces) {
      const cell = cells[surface.id]
      if (
        !cell ||
        !['generated', 'reference', 'out_of_scope'].includes(cell.kind)
      )
        errors.push(`${row.id}: invalid or empty ${surface.id}`)
      if (cell?.kind === 'out_of_scope' && !cell.reason?.trim())
        errors.push(`${row.id}: empty out_of_scope reason for ${surface.id}`)
    }
    for (const [contract, owners] of Object.entries(row.owners ?? {})) {
      if (owners.length > 1)
        errors.push(`${row.id}: duplicate owner for ${contract}`)
      for (const owner of owners) {
        const surface = matrix.surfaces.find((item) => item.id === owner)
        if (!surface) errors.push(`${row.id}: unknown owner surface ${owner}`)
        if (contract.startsWith('cli_') && owner !== 'cli_help')
          errors.push(`${row.id}: ${contract} cannot be owned by ${owner}`)
        if (contract.startsWith('mcp_') && owner !== 'mcp_tools')
          errors.push(`${row.id}: ${contract} cannot be owned by ${owner}`)
        if (contract === 'discovery' && owner !== 'agent_surface')
          errors.push(`${row.id}: discovery cannot be owned by ${owner}`)
      }
    }
    const requiredOwners = [
      ...((row.cli_commands ?? []).length ? CLI_OWNER_CONTRACTS : []),
      ...((row.mcp_tools ?? []).length ? MCP_OWNER_CONTRACTS : []),
      ...((row.agent_surface_keys ?? []).length ? ['discovery'] : []),
    ]
    for (const contract of requiredOwners)
      if (row.owners?.[contract]?.length !== 1)
        errors.push(`${row.id}: missing owner for ${contract}`)
    if (
      (row.mcp_tools ?? []).length &&
      (cells.mcp_tools?.scope?.kind !== 'mcp_tool' ||
        !row.mcp_tools.includes(cells.mcp_tools.scope.name))
    )
      errors.push(`${row.id}: MCP contracts require their tool scope`)
    for (const command of row.cli_commands ?? []) {
      const commandSnapshot = snapshot.commands.find(
        (item) => item.path === command,
      )
      const expectedOptions = row.cli_options?.[command]
      if (
        !expectedOptions ||
        JSON.stringify(expectedOptions) !==
          JSON.stringify(commandSnapshot?.options ?? [])
      )
        errors.push(`${row.id}: invalid CLI contract cli_option`)
      const help = cliHelp(command)
      if (help === null) continue
      if (
        row.owners?.cli_option &&
        (!expectedOptions.length || !help.includes('OPTIONS:'))
      )
        errors.push(`${row.id}: invalid CLI contract cli_option`)
      if (
        row.owners?.cli_json &&
        (!commandSnapshot?.options?.includes('--json') ||
          !help.includes('Print stable JSON output'))
      )
        errors.push(`${row.id}: invalid CLI contract cli_json`)
      if (row.owners?.cli_auth) {
        const authOptions =
          commandSnapshot?.options?.filter((option) =>
            ['--token', '--profile'].includes(option),
          ) ?? []
        if (row.cli_no_auth ? authOptions.length : authOptions.length === 0)
          errors.push(`${row.id}: invalid CLI contract cli_auth`)
      }
    }
    for (const allowance of row.literal_allowances ?? [])
      if (!allowance.text?.trim() || !allowance.reason?.trim())
        errors.push(`${row.id}: literal allowance requires text and reason`)
  }
  const checkInventory = (actual, listed, label) => {
    const expected = new Set(actual)
    const found = new Map()
    for (const row of listed) {
      const value = row.identifier
      if (found.has(value)) errors.push(`duplicate ${label}: ${value}`)
      found.set(value, row)
      if (!expected.has(value)) errors.push(`unknown ${label}: ${value}`)
    }
    for (const value of expected)
      if (!found.has(value)) errors.push(`missing ${label}: ${value}`)
  }
  checkInventory(executable, commandRows, 'CLI command')
  checkInventory(tools, toolRows, 'MCP tool')
  checkInventory(agentKeys, agentRows, 'agent surface key')
  const contracts = matrix.contracts ?? []
  const contractIds = new Set()
  for (const contract of contracts) {
    if (contractIds.has(contract.id))
      errors.push(`duplicate contract id: ${contract.id}`)
    contractIds.add(contract.id)
    if (!contract.implementation_path || !contract.identifier)
      errors.push(`invalid contract: ${contract.id}`)
    else {
      const implementation = readFile(contract.implementation_path)
      if (!implementation.includes(contract.identifier))
        errors.push(`missing contract implementation: ${contract.id}`)
    }
  }
  const contractRows = new Map()
  for (const row of rows) {
    for (const contract of row.contracts ?? []) {
      if (!contractIds.has(contract))
        errors.push(`${row.id}: unknown contract ${contract}`)
      if (contractRows.has(contract))
        errors.push(`contract mapped more than once: ${contract}`)
      contractRows.set(contract, row.id)
    }
    for (const [surface, cell] of Object.entries(resolvedCells(matrix, row))) {
      if (!cell) continue
      if (cell.kind === 'reference') {
        const identifiers = cellIdentifiers(cell)
        if (!cell.path || identifiers.length === 0)
          errors.push(
            `${row.id}: reference ${surface} lacks path or identifier`,
          )
        else {
          const fileContent = readFile(cell.path)
          const content =
            cell.scope?.kind === 'mcp_tool'
              ? mcpToolBlock(mcpSource, cell.scope.name)
              : fileContent
          for (const identifier of identifiers)
            if (!content.includes(identifier))
              errors.push(
                `${row.id}: missing reference identifier ${identifier}`,
              )
          const scopedIdentifiers = cell.scoped_identifiers ?? []
          if (scopedIdentifiers.length && cell.scope?.kind !== 'mcp_tool')
            errors.push(
              `${row.id}: scoped reference identifiers require an MCP tool scope`,
            )
          for (const identifier of scopedIdentifiers)
            if (!content.includes(identifier))
              errors.push(
                `${row.id}: missing scoped reference identifier ${identifier}`,
              )
          if (surface === 'mcp_tools' && cell.scope?.kind === 'mcp_tool') {
            const requiredMcpContracts = Object.keys(row.owners ?? {}).filter(
              (contract) => contract.startsWith('mcp_'),
            )
            const contractIdentifiers = cell.contract_identifiers ?? {}
            for (const contract of requiredMcpContracts) {
              const expected = contractIdentifiers[contract]
              if (!Array.isArray(expected))
                errors.push(
                  `${row.id}: missing MCP identifiers for ${contract}`,
                )
              if (contract === 'mcp_input') {
                const actualFields = objectFieldNames(content, 'inputSchema:')
                if (
                  JSON.stringify(actualFields) !==
                  JSON.stringify((expected ?? []).map((field) => field))
                )
                  errors.push(`${row.id}: invalid MCP contract ${contract}`)
                continue
              }
              if (contract === 'mcp_output') {
                const outputSchema = content.match(
                  /outputSchema:\s*([A-Za-z_]\w*)/,
                )?.[1]
                const actualFields = outputSchema
                  ? schemaFieldNames(mcpSource, outputSchema)
                  : objectFieldNames(content, 'outputSchema:')
                if (
                  JSON.stringify(actualFields) !==
                  JSON.stringify(expected ?? [])
                )
                  errors.push(`${row.id}: invalid MCP contract ${contract}`)
                continue
              }
              if (!expected?.length)
                errors.push(`${row.id}: empty MCP identifiers for ${contract}`)
              for (const identifier of expected ?? [])
                if (!identifier || !content.includes(identifier))
                  errors.push(
                    `${row.id}: missing MCP ${contract} identifier ${identifier}`,
                  )
            }
          }
          const fileScope = cell.file_scope
          const fileIdentifierContent =
            fileScope?.kind === 'const_object'
              ? constObjectBlock(fileContent, fileScope.name)
              : fileContent
          for (const identifier of cell.file_identifiers ?? [])
            if (!fileIdentifierContent.includes(identifier))
              errors.push(
                `${row.id}: missing file reference identifier ${identifier}`,
              )
        }
      }
      if (cell.kind === 'generated') {
        const identifiers = cellIdentifiers(cell)
        if (!(cell.source ?? cell.path) || identifiers.length === 0)
          errors.push(
            `${row.id}: generated ${surface} lacks source or identifier`,
          )
        else {
          const generated = readFile(cell.source ?? cell.path)
          for (const identifier of identifiers)
            if (!generated.includes(identifier))
              errors.push(
                `${row.id}: missing generated identifier ${identifier}`,
              )
        }
      }
    }
  }
  for (const contract of contractIds)
    if (!contractRows.has(contract))
      errors.push(`unmapped contract: ${contract}`)
  const seenIdentifiers = new Map()
  for (const row of rows)
    for (const [namespace, identifiers] of [
      ['cli', row.cli_commands ?? []],
      ['mcp', row.mcp_tools ?? []],
      ['agent', row.agent_surface_keys ?? []],
    ])
      for (const identifier of identifiers) {
        const key = `${namespace}:${identifier}`
        if (seenIdentifiers.has(key))
          errors.push(`duplicate capability identifier: ${key}`)
        seenIdentifiers.set(key, row.id)
      }
  for (const row of rows) {
    const cells = resolvedCells(matrix, row)
    const ownerSurfaces = new Set(Object.values(row.owners ?? {}).flat())
    const ownerSources = [
      [...ownerSurfaces]
        .filter((surface) => cells[surface]?.kind !== 'generated')
        .map((surface) => cells[surface]?.source ?? cells[surface]?.path)
        .filter(Boolean),
    ].flat()
    if (ownerSurfaces.has('cli_help'))
      ownerSources.push(
        ...(row.cli_commands ?? []).flatMap((command) => {
          const content = cliHelp(command)
          return content === null ? [] : [{ cliHelp: command, content }]
        }),
      )
    const allowances = row.literal_allowances ?? []
    for (const ownerSource of ownerSources) {
      const sourcePath =
        typeof ownerSource === 'string' ? ownerSource : ownerSource.cliHelp
      const source =
        typeof ownerSource === 'string'
          ? readFile(ownerSource)
          : ownerSource.content
      for (const [surface, cell] of Object.entries(cells)) {
        if (cell?.kind !== 'reference' || !cell.path) continue
        if (cell.path === sourcePath || ownerSurfaces.has(surface)) continue
        errors.push(
          ...validateLiteralDuplication({
            source,
            reference: readFile(cell.path),
            allowances,
          }).map((error) => `${row.id}: ${error}`),
        )
      }
    }
  }
  return errors
}

export function validateLiteralDuplication({
  source,
  reference,
  allowance = false,
  allowances = [],
}) {
  if (allowance) return []
  const normalize = (value) => value.replace(/\s+/g, ' ').trim()
  const prose = (value) =>
    normalize(
      value
        .replace(/```[\s\S]*?```/g, '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*]\s+/, ''))
        .filter(
          (line) =>
            !/^\s*(?:https?:\/\/|#|`[^`]+`$|[\w.-]+\/[\w./-]+$)/.test(line),
        )
        .join('\n'),
    )
  const sourceCharacters = Array.from(prose(source))
  const referenceText = prose(reference)
  const allowedTexts = allowances.map((item) => prose(item.text))
  for (let index = 0; index <= sourceCharacters.length - 80; index += 1) {
    const window = sourceCharacters.slice(index, index + 80).join('')
    const trimmedWindow = window.trim()
    if (
      referenceText.includes(window) &&
      !allowedTexts.some(
        (text) => text.includes(window) || text.includes(trimmedWindow),
      )
    )
      return ['literal prose duplication (80+ continuous characters)']
  }
  return []
}

function sectionLines(help, heading) {
  const lines = help.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `${heading}:`)
  if (start < 0) return []
  const result = []
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break
    if (line.trim() && !/^\s{2,}/.test(line)) break
    result.push(line)
  }
  return result
}

export function parseHelp(help) {
  const lines = help.split(/\r?\n/)
  const usageIndex = lines.findIndex((line) => line.trim() === 'USAGE:')
  let usage = ''
  if (usageIndex >= 0) {
    usage =
      lines
        .slice(usageIndex + 1)
        .find((line) => line.trim())
        ?.trim() ?? ''
  }

  const options = []
  let inOptions = false
  for (const line of lines) {
    if (line.trim() === 'OPTIONS:') {
      inOptions = true
      continue
    }
    if (inOptions && line && !/^\s/.test(line)) break
    if (!inOptions) continue
    for (const match of line.matchAll(/(^|\s)(--[a-z0-9][a-z0-9-]*)\b/g)) {
      if (!options.includes(match[2])) options.push(match[2])
    }
  }

  return { usage, options }
}

export function commandPathsFromHelp(help) {
  return sectionLines(help, 'COMMANDS')
    .map(
      (line) => line.match(/^\s{2}([^\s].*?)\s+<OPTIONS>(?:\s{2,}.*)?$/)?.[1],
    )
    .filter((path) => path && !path.startsWith('['))
    .map((path) => path.replace(/\s+$/, ''))
}

export function generateSurface({
  cliPath = CLI_PATH,
  run = null,
  generatedDate,
} = {}) {
  const helpRunner =
    run ??
    ((args) => {
      const result = spawnSync(process.execPath, [cliPath, ...args, '--help'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      })
      if (result.status !== 0) {
        throw new Error(
          `failed to read help for ${args.join(' ')}: ${result.stderr || result.stdout}`,
        )
      }
      return result.stdout
    })

  const commands = []
  const seen = new Set()
  const visit = (path) => {
    if (seen.has(path)) return
    seen.add(path)
    const help = helpRunner(path ? path.split(' ') : [])
    const parsed = parseHelp(help)
    commands.push({ path, usage: parsed.usage, options: parsed.options })
    for (const child of commandPathsFromHelp(help)) {
      visit(path ? `${path} ${child}` : child)
    }
  }
  visit('')
  const surface = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    package_version: CLI_PACKAGE_VERSION,
    commands,
  }
  return generatedDate ? { ...surface, generated_date: generatedDate } : surface
}

export function utcDate(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && utcDate(parsed) === value
}

function commandTokens(value) {
  return (
    value
      .replace(/\\(['"])/g, '$1')
      .match(/(?:[^\s'"`]|'[^']*'|"[^"]*")+/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
  )
}

export function extractCommandExamples(content) {
  const examples = []
  const pattern = /(?:@artifactshare\/cli|\bartifactshare)\s+([^\n`]+)/g
  for (const match of content.matchAll(pattern)) {
    const tokens = commandTokens(match[1])
    if (tokens[0] && /^[a-z][a-z0-9-]*$/.test(tokens[0])) examples.push(tokens)
  }
  return examples
}

export function validateDocumentExamples(snapshot, documents) {
  const commands = new Map(
    snapshot.commands.map((command) => [command.path, command]),
  )
  const errors = []
  for (const [name, content] of Object.entries(documents)) {
    const examples = extractCommandExamples(content)
    for (const tokens of examples) {
      if (tokens[0]?.startsWith('<')) continue
      let command = ''
      let matched = null
      for (let length = Math.min(3, tokens.length); length > 0; length -= 1) {
        const candidate = tokens.slice(0, length).join(' ')
        if (commands.has(candidate)) {
          command = candidate
          matched = commands.get(candidate)
          break
        }
      }
      if (!matched) {
        errors.push(`${name}: unknown command example ${tokens.join(' ')}`)
        continue
      }
      for (const token of tokens.slice(command.split(' ').length)) {
        const option = token.match(/^(--[a-z0-9][a-z0-9-]*)(?:=|$)/)?.[1]
        if (option && !matched.options.includes(option)) {
          errors.push(
            `${name}: ${command} example uses unknown option ${option}`,
          )
        }
      }
    }
  }
  return errors
}

export function validateCommandCoverage(snapshot, documents) {
  const paths = snapshot.commands.map((command) => command.path).filter(Boolean)
  const errors = []
  for (const [name, content] of Object.entries(documents)) {
    if (!name.includes('README') && !name.includes('cli-command-catalog'))
      continue
    for (const path of paths) {
      if (!content.includes(`\`${path}\``)) {
        errors.push(`${name}: missing public command path ${path}`)
      }
    }
  }
  return errors
}

function readSnapshot() {
  return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))
}

function documentsAtRoot() {
  return Object.fromEntries(
    DOCUMENT_PATHS.map((path) => [
      path,
      readFileSync(resolve(ROOT, path), 'utf8'),
    ]),
  )
}

export function compareSurfaceSnapshots(generated, committed) {
  const generatedText = `${JSON.stringify(
    { ...generated, generated_date: committed.generated_date },
    null,
    2,
  )}\n`
  const committedText = `${JSON.stringify(committed, null, 2)}\n`
  return {
    generatedDateIsValid: isRealIsoDate(committed.generated_date),
    deterministicFieldsMatch: generatedText === committedText,
  }
}

export function checkSurface() {
  const generated = generateSurface()
  const committed = readSnapshot()
  const errors = []
  const comparison = compareSurfaceSnapshots(generated, committed)
  if (!comparison.generatedDateIsValid) {
    errors.push(
      `${OUTPUT_PATH} must contain a real generated_date in YYYY-MM-DD format`,
    )
  }
  if (!comparison.deterministicFieldsMatch) {
    errors.push(
      `${OUTPUT_PATH} is out of date; run pnpm generate:cli-reference`,
    )
  }
  errors.push(...validateDocumentExamples(committed, documentsAtRoot()))
  errors.push(...validateCommandCoverage(committed, documentsAtRoot()))
  const matrix = JSON.parse(readFileSync(CAPABILITY_MATRIX_PATH, 'utf8'))
  const helpCache = new Map()
  const cliHelp = (command) => {
    if (helpCache.has(command)) return helpCache.get(command)
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, ...command.split(' '), '--help'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )
    const help = result.status === 0 ? result.stdout : ''
    helpCache.set(command, help)
    return help
  }
  errors.push(
    ...validateCapabilityMatrix({
      matrix,
      snapshot: committed,
      mcpSource: readFileSync(MCP_TOOLS_SOURCE_PATH, 'utf8'),
      agentSource: readFileSync(AGENT_SURFACE_SOURCE_PATH, 'utf8'),
      cliHelp,
    }),
  )
  return errors
}

function main() {
  if (process.argv.includes('--check')) {
    const errors = checkSurface()
    if (errors.length) {
      for (const error of errors) console.error(error)
      process.exitCode = 1
    }
    return
  }
  const surface = generateSurface({ generatedDate: utcDate() })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(surface, null, 2)}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
