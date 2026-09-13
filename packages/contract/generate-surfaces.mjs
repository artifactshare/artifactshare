import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CONTRACT_ROOT = resolve(ROOT, 'packages/contract')
const CLI_PATH = resolve(ROOT, 'packages/cli/dist/index.js')
const CLI_PACKAGE_PATH = resolve(ROOT, 'packages/cli/package.json')
const OUTPUT_PATH = resolve(
  ROOT,
  'apps/web/app/lib/cli-reference-surface.generated.json',
)
const CAPABILITY_SOURCE_PATH = resolve(
  CONTRACT_ROOT,
  'src/capability-matrix.json',
)
const OPENAPI_OUTPUT_PATH = resolve(
  ROOT,
  'apps/web/app/lib/openapi.generated.json',
)
const SKILL_PATH = resolve(ROOT, 'packages/cli/skills/artifactshare/SKILL.md')
const EN_MESSAGES_PATH = resolve(ROOT, 'apps/web/app/i18n/en.json')
const JA_MESSAGES_PATH = resolve(ROOT, 'apps/web/app/i18n/ja.json')
const MCP_TOOLS_SOURCE_PATH = resolve(
  ROOT,
  'apps/web/app/services/mcp/tools.server.ts',
)
const AGENT_SURFACE_SOURCE_PATH = resolve(
  ROOT,
  'apps/web/app/lib/agent-surface.ts',
)
const CLI_PACKAGE_VERSION = JSON.parse(
  readFileSync(CLI_PACKAGE_PATH, 'utf8'),
).version
const {
  CLI_AGENT_COMMANDS,
  CLI_QUICK_REFERENCE,
  CLI_README_COMMANDS,
  MCP_OPENAPI_METADATA,
} = await import('./src/surface-contract.mjs')
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
            !/^\s*(?:https?:\/\/|#|`[^`]+`$|[\w.-]+\/[\w./-]+$|npm exec --yes --package=@artifactshare\/cli -- artifactshare\b)/.test(
              line,
            ),
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

export async function generateSurface({
  cliPath = CLI_PATH,
  run = null,
  helpCache = new Map(),
  generatedDate,
} = {}) {
  // Help must come from the current sources, never an absent or stale bundle.
  if (!run && cliPath === CLI_PATH)
    execFileSync('pnpm', ['--filter', '@artifactshare/cli', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  const uncachedHelpRunner =
    run ?? (await import(pathToFileURL(cliPath).href)).generateCliHelp
  const helpRunner = async (args) => {
    const command = args.join(' ')
    if (helpCache.has(command)) return helpCache.get(command)
    const help = await uncachedHelpRunner(args)
    helpCache.set(command, help)
    return help
  }

  const seen = new Set()
  const visit = async (path) => {
    if (seen.has(path)) return []
    seen.add(path)
    const help = await helpRunner(path ? path.split(' ') : [])
    const parsed = parseHelp(help)
    const children = await Promise.all(
      commandPathsFromHelp(help).map((child) =>
        visit(path ? `${path} ${child}` : child),
      ),
    )
    return [
      { path, usage: parsed.usage, options: parsed.options },
      ...children.flat(),
    ]
  }
  const commands = await visit('')
  const surface = {
    schema_version: CLI_SURFACE_SCHEMA_VERSION,
    package_version: CLI_PACKAGE_VERSION,
    commands,
  }
  return generatedDate ? { ...surface, generated_date: generatedDate } : surface
}

export function cliInvocation(command) {
  return `npm exec --yes --package=@artifactshare/cli -- artifactshare ${command}`
}

export function generateCliAgentCommands() {
  return Object.fromEntries(
    Object.entries(CLI_AGENT_COMMANDS).map(([name, command]) => [
      name,
      cliInvocation(command),
    ]),
  )
}

function markdownTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? '').length),
    ),
  )
  const renderRow = (row) =>
    `| ${row.map((value, index) => String(value ?? '').padEnd(widths[index])).join(' | ')} |`
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n')
}

export function renderCliReadmeCommandTable() {
  return markdownTable(
    ['Command', 'What it does'],
    CLI_README_COMMANDS.map(([command, description]) => [
      command.startsWith('`') ? command : `\`${command}\``,
      description,
    ]),
  )
}

export function renderSkillQuickReferenceTable() {
  return markdownTable(
    ['Task', 'Command'],
    CLI_QUICK_REFERENCE.map(([task, command]) => [
      task,
      command === 'preview <file> --json (local, no sign-in)'
        ? '`preview <file> --json` (local, no sign-in)'
        : `\`${command}\``,
    ]),
  )
}

export function replaceCliReadmeCommandTable(content) {
  const marker = '## Commands\n\n'
  const start = content.indexOf(marker)
  const end = content.indexOf('\n\nPublic command paths', start + marker.length)
  if (start < 0 || end < 0)
    throw new Error('CLI README command table not found')
  return `${content.slice(0, start + marker.length)}${renderCliReadmeCommandTable()}${content.slice(end)}`
}

export function replaceSkillQuickReferenceTable(content) {
  const marker = '## Quick reference\n\n'
  const start = content.indexOf(marker)
  const end = content.indexOf('\n\n## Authentication', start + marker.length)
  if (start < 0 || end < 0)
    throw new Error('bundled skill command table not found')
  return `${content.slice(0, start + marker.length)}${renderSkillQuickReferenceTable()}${content.slice(end)}`
}

export function generateCapabilityMatrix(snapshot) {
  const matrix = JSON.parse(readFileSync(CAPABILITY_SOURCE_PATH, 'utf8'))
  for (const row of matrix.capabilities ?? []) {
    for (const command of row.cli_commands ?? []) {
      const commandSnapshot = snapshot.commands.find(
        (item) => item.path === command,
      )
      if (!commandSnapshot) continue
      row.cli_options ??= {}
      row.cli_options[command] = commandSnapshot.options
    }
  }
  return matrix
}

export function generateCapabilityMatrixText(snapshot) {
  const matrix = generateCapabilityMatrix(snapshot)
  const sourceText = readFileSync(CAPABILITY_SOURCE_PATH, 'utf8')
  return JSON.stringify(JSON.parse(sourceText)) === JSON.stringify(matrix)
    ? sourceText
    : generatedJsonText(matrix)
}

export function generateOpenApiSurface({ host = 'artifactshare.com' } = {}) {
  const apex = `https://${host}`
  const metadata = MCP_OPENAPI_METADATA
  return {
    openapi: metadata.openapi,
    info: {
      title: metadata.title,
      version: metadata.version,
      description: metadata.description,
    },
    servers: [{ url: apex }],
    paths: {
      [metadata.resourcePath]: {
        post: {
          summary: 'MCP endpoint (JSON-RPC over Streamable HTTP)',
          description: metadata.endpointDescription,
          security: [{ oauth2: [...metadata.scopes] }],
          responses: {
            200: { description: 'JSON-RPC response.' },
            401: {
              description:
                'Missing or invalid bearer token; the WWW-Authenticate header points at the protected-resource metadata.',
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth2: {
          type: 'oauth2',
          description: metadata.oauthDescription,
          flows: {
            authorizationCode: {
              authorizationUrl: apex + metadata.oauthAuthorizePath,
              tokenUrl: apex + `${metadata.authBasePath}/oauth2/token`,
              scopes: { ...metadata.scopeDescriptions },
            },
          },
        },
      },
    },
  }
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)\\b`))
  return match ? Number(match[1]) : null
}

export function productContractProblems({ canonical, cli, en, ja, api }) {
  const problems = []
  const keyLength = numericConstant(canonical, 'ARTIFACT_KEY_MAX_LENGTH')
  const cliKeyLength = numericConstant(cli, 'MAX_SHARE_KEY_LENGTH')
  const refreshDays = numericConstant(canonical, 'REFRESH_CREDENTIAL_TTL_DAYS')

  if (keyLength === null) {
    problems.push('canonical artifact key length is missing')
  } else if (
    (cliKeyLength !== null && cliKeyLength !== keyLength) ||
    (cliKeyLength === null && !cli.includes('ARTIFACT_KEY_MAX_LENGTH'))
  ) {
    problems.push(
      `CLI artifact key length ${cliKeyLength ?? 'missing'} does not match ${keyLength}`,
    )
  }

  if (keyLength !== null && !api.includes('${ARTIFACT_KEY_MAX_LENGTH}')) {
    problems.push('API artifact key error does not derive from the contract')
  }

  if (refreshDays === null) {
    problems.push('canonical refresh credential lifetime is missing')
  } else {
    if (!en.includes(`${refreshDays} days`))
      problems.push('English refresh credential copy is stale')
    if (!ja.includes(`${refreshDays} 日`))
      problems.push('Japanese refresh credential copy is stale')
  }

  return problems
}

export function checkProductContracts(root = ROOT) {
  const read = (relativePath) =>
    readFileSync(resolve(root, relativePath), 'utf8')
  return productContractProblems({
    canonical: read('packages/contract/src/index.ts'),
    cli: read('packages/cli/src/command-runners/share.ts'),
    en: JSON.stringify(JSON.parse(read('apps/web/app/i18n/en.json'))),
    ja: JSON.stringify(JSON.parse(read('apps/web/app/i18n/ja.json'))),
    api: read('apps/web/app/routes/api.shareables.uploads.tsx'),
  })
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
  const pattern =
    /(?:npm exec\s+--yes\s+--package=@artifactshare\/cli\s+--\s+artifactshare|@artifactshare\/cli|\bartifactshare)\s+([^\n`]+)/g
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

function readApexHost() {
  const source = readFileSync(
    resolve(ROOT, 'apps/web/app/lib/hosts.ts'),
    'utf8',
  )
  return source.match(/APEX_HOST\s*=\s*'([^']+)'/)?.[1] ?? 'artifactshare.com'
}

function generatedJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function generatedOpenApiText(value) {
  return generatedJsonText(value).replace(
    '"oauth2": [\n              "openid",\n              "profile",\n              "email",\n              "offline_access"\n            ]',
    '"oauth2": ["openid", "profile", "email", "offline_access"]',
  )
}

function compareGeneratedFile(path, expected) {
  if (!existsSync(path))
    return `${path} is missing; run pnpm generate:contract-surfaces`
  if (readFileSync(path, 'utf8') !== expected)
    return `${path} is out of date; run pnpm generate:contract-surfaces`
  return null
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
  const generatedText = JSON.stringify({
    ...generated,
    generated_date: committed.generated_date,
  })
  const committedText = JSON.stringify(committed)
  return {
    generatedDateIsValid: isRealIsoDate(committed.generated_date),
    deterministicFieldsMatch: generatedText === committedText,
  }
}

export async function checkSurface() {
  const helpCache = new Map()
  const committed = readSnapshot()
  const generated = await generateSurface({ helpCache })
  const errors = []
  const comparison = compareSurfaceSnapshots(generated, committed)
  if (!comparison.generatedDateIsValid) {
    errors.push(
      `${OUTPUT_PATH} must contain a real generated_date in YYYY-MM-DD format`,
    )
  }
  if (!comparison.deterministicFieldsMatch) {
    errors.push(
      `${OUTPUT_PATH} is out of date; run pnpm generate:contract-surfaces`,
    )
  }
  errors.push(...validateDocumentExamples(generated, documentsAtRoot()))
  errors.push(...validateCommandCoverage(generated, documentsAtRoot()))
  const matrix = JSON.parse(readFileSync(CAPABILITY_MATRIX_PATH, 'utf8'))
  const matrixProblem = compareGeneratedFile(
    CAPABILITY_MATRIX_PATH,
    generateCapabilityMatrixText(generated),
  )
  if (matrixProblem) errors.push(matrixProblem)
  const openapiProblem = compareGeneratedFile(
    OPENAPI_OUTPUT_PATH,
    generatedOpenApiText(generateOpenApiSurface({ host: readApexHost() })),
  )
  if (openapiProblem) errors.push(openapiProblem)
  const agentCommandOutputPath = resolve(
    ROOT,
    'apps/web/app/lib/cli-agent-commands.generated.json',
  )
  const agentCommandProblem = compareGeneratedFile(
    agentCommandOutputPath,
    generatedJsonText(generateCliAgentCommands()),
  )
  if (agentCommandProblem) errors.push(agentCommandProblem)
  if (existsSync(SKILL_PATH)) {
    const expectedSkill = replaceSkillQuickReferenceTable(
      readFileSync(SKILL_PATH, 'utf8'),
    )
    if (expectedSkill !== readFileSync(SKILL_PATH, 'utf8'))
      errors.push(
        `${SKILL_PATH} is out of date; run pnpm generate:contract-surfaces`,
      )
  }
  const readmePath = resolve(ROOT, 'packages/cli/README.md')
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8')
    if (replaceCliReadmeCommandTable(readme) !== readme)
      errors.push(
        `${readmePath} is out of date; run pnpm generate:contract-surfaces`,
      )
  }
  errors.push(
    ...productContractProblems({
      canonical: readFileSync(resolve(CONTRACT_ROOT, 'src/index.ts'), 'utf8'),
      cli: readFileSync(
        resolve(ROOT, 'packages/cli/src/command-runners/share.ts'),
        'utf8',
      ),
      en: readFileSync(EN_MESSAGES_PATH, 'utf8'),
      ja: readFileSync(JA_MESSAGES_PATH, 'utf8'),
      api: readFileSync(
        resolve(ROOT, 'apps/web/app/routes/api.shareables.uploads.tsx'),
        'utf8',
      ),
    }),
  )
  const cliHelp = (command) => {
    if (helpCache.has(command)) return helpCache.get(command)
    errors.push(
      `capability matrix command is missing from the generated CLI surface: ${command}`,
    )
    return ''
  }
  errors.push(
    ...validateCapabilityMatrix({
      matrix,
      snapshot: generated,
      mcpSource: readFileSync(MCP_TOOLS_SOURCE_PATH, 'utf8'),
      agentSource: readFileSync(AGENT_SURFACE_SOURCE_PATH, 'utf8'),
      readFile: (path) => readFileSync(resolve(ROOT, path), 'utf8'),
      cliHelp,
    }),
  )
  return errors
}

async function main() {
  if (process.argv.includes('--check')) {
    const errors = await checkSurface()
    if (errors.length) {
      for (const error of errors) console.error(error)
      process.exitCode = 1
    }
    return
  }
  const previous = existsSync(OUTPUT_PATH) ? readSnapshot() : null
  const generated = await generateSurface()
  const comparison = previous
    ? compareSurfaceSnapshots(generated, previous)
    : null
  const surface = {
    ...generated,
    generated_date:
      comparison?.generatedDateIsValid && comparison.deterministicFieldsMatch
        ? previous.generated_date
        : utcDate(),
  }
  const surfaceText = generatedJsonText(surface)
  if (
    !existsSync(OUTPUT_PATH) ||
    JSON.stringify(readSnapshot()) !== JSON.stringify(surface)
  )
    writeFileSync(OUTPUT_PATH, surfaceText)
  const matrixText = generateCapabilityMatrixText(surface)
  if (
    !existsSync(CAPABILITY_MATRIX_PATH) ||
    readFileSync(CAPABILITY_MATRIX_PATH, 'utf8') !== matrixText
  )
    writeFileSync(CAPABILITY_MATRIX_PATH, matrixText)
  writeFileSync(
    OPENAPI_OUTPUT_PATH,
    generatedOpenApiText(generateOpenApiSurface({ host: readApexHost() })),
  )
  writeFileSync(
    resolve(ROOT, 'apps/web/app/lib/cli-agent-commands.generated.json'),
    generatedJsonText(generateCliAgentCommands()),
  )
  const skill = readFileSync(SKILL_PATH, 'utf8')
  writeFileSync(SKILL_PATH, replaceSkillQuickReferenceTable(skill))
  const readmePath = resolve(ROOT, 'packages/cli/README.md')
  const readme = readFileSync(readmePath, 'utf8')
  writeFileSync(readmePath, replaceCliReadmeCommandTable(readme))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
