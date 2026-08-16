import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { request } from 'node:https'
import { connect } from 'node:net'
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Each failure knows how it is fixed, so the caller never has to guess from the
// message. `reset` means recreating the local DB helps; `input` means a file or
// tool on this machine has to change first; `usage` means the arguments do.
function setupError(recovery, message, options) {
  return Object.assign(new Error(message, options), { recovery })
}

// Preparing local inputs (certificates, .dev.vars, schema.sql) can also fail
// through a bare I/O error. Those need the same human fix as the explicit
// throws, so anything unclassified raised here is treated as an input problem.
function asInput(run) {
  try {
    return run()
  } catch (error) {
    if (error?.recovery) throw error
    throw setupError('input', error?.message ?? String(error), { cause: error })
  }
}

const RECOVERY_COMMANDS = {
  input:
    'Fix the reported input (.dev.vars value, mkcert install, or apps/web/db/schema.sql), then rerun pnpm dev:setup',
  usage: 'pnpm dev:setup --target app',
}

const ROOT = resolve(import.meta.dirname, '..')
const APP = join(ROOT, 'apps/web')
const SCHEMA = join(APP, 'db/schema.sql')

export const DEV_SERVICES = [
  {
    name: 'og-image',
    origin: 'https://localhost:5175',
    path: '/',
    expected: { status: 404, contentType: 'text/plain', body: 'not found' },
    command: ['pnpm', 'dev:og-image'],
  },
  {
    name: 'app',
    origin: 'https://localhost:5173',
    path: '/dev/sign-in',
    expected: {
      status: 200,
      contentType: 'text/html',
      body: 'Local dev sign-in',
    },
    command: ['pnpm', 'dev:app'],
  },
  {
    name: 'sandbox',
    origin: 'https://localhost:5174',
    path: '/',
    headers: { 'mf-original-hostname': 'probe.sandbox.localhost' },
    expected: {
      status: 401,
      contentType: 'text/plain',
      body: 'Invalid token',
    },
    command: ['pnpm', 'dev:sandbox'],
  },
]

export async function selectMissingDevServices(services, probe = probeHttps) {
  const states = await Promise.all(
    services.map(async (service) => ({
      service,
      available: await probe(service),
    })),
  )
  return states.reduce(
    (result, { service, available }) => {
      result[available ? 'reused' : 'missing'].push(service)
      return result
    },
    { missing: [], reused: [] },
  )
}

function probeHttps(service) {
  return new Promise((finish, reject) => {
    const req = request(
      new URL(service.path, service.origin),
      {
        method: 'GET',
        rejectUnauthorized: false,
        headers: service.headers,
        timeout: 1_000,
      },
      (response) => {
        response.setEncoding('utf8')
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          const actual = {
            status: response.statusCode,
            contentType: response.headers['content-type'],
            body,
          }
          if (serviceIdentityMatches(service.expected, actual)) finish(true)
          else
            reject(
              new Error(
                `${service.name} origin ${service.origin} is occupied by an unexpected HTTPS service`,
              ),
            )
        })
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', async () => {
      if (await portIsOpen(service.origin))
        reject(
          new Error(
            `${service.name} origin ${service.origin} is occupied but did not answer as the expected HTTPS service`,
          ),
        )
      else finish(false)
    })
    req.end()
  })
}

export function serviceIdentityMatches(expected, actual) {
  return (
    actual.status === expected.status &&
    actual.contentType?.startsWith(expected.contentType) === true &&
    actual.body.includes(expected.body)
  )
}

function portIsOpen(origin) {
  const url = new URL(origin)
  return new Promise((finish) => {
    const socket = connect(Number(url.port), url.hostname)
    socket.setTimeout(250)
    socket.on('connect', () => {
      socket.destroy()
      finish(true)
    })
    socket.on('timeout', () => {
      socket.destroy()
      finish(false)
    })
    socket.on('error', () => finish(false))
  })
}

function normalizeSql(sql) {
  return withoutSqlComments(sql).replace(/\s+/g, ' ').trim()
}

// SQLite stores DDL with `IF NOT EXISTS` removed and the leading keywords
// upper-cased, so the expected side needs the same treatment or a lower-case
// declaration in schema.sql reports a permanent `definition differs`.
export function normalizeDefinition(sql) {
  return normalizeSql(sql).replace(
    /^(CREATE)\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(IF\s+NOT\s+EXISTS\s+)?/i,
    (_, create, unique, type) =>
      `${create.toUpperCase()} ${unique ? 'UNIQUE ' : ''}${type.toUpperCase()} `,
  )
}

export function resetStatements(rows) {
  const internal = (name) =>
    name.startsWith('sqlite_') || name.startsWith('_cf_')
  const tables = rows.filter(
    (row) => row.type === 'table' && row.name && !internal(row.name),
  )
  const names = tables.map((row) => row.name)
  const remaining = new Set(names)
  const dependencies = new Map()
  for (const row of tables) {
    const parents = new Set()
    // SQLite keeps comments inside the stored DDL, so a note mentioning
    // REFERENCES would otherwise add a phantom edge and force the cycle path.
    for (const match of withoutSqlComments(row.sql ?? '').matchAll(
      /\bREFERENCES\s+("(?:""|[^"])+"|\[[^\]]+\]|`(?:``|[^`])+`|[^\s(,]+)/gi,
    )) {
      const parent = unquoteSqlIdentifier(match[1])
      if (parent !== row.name && remaining.has(parent)) parents.add(parent)
    }
    dependencies.set(row.name, parents)
  }
  const ordered = []
  while (remaining.size) {
    const ready = [...remaining].filter(
      (name) =>
        ![...remaining].some(
          (child) => child !== name && dependencies.get(child)?.has(name),
        ),
    )
    if (!ready.length) {
      // A cycle leaves no safe order; creation order puts parents first, so
      // fall back to its reverse and give children the better chance.
      ordered.push(...[...remaining].reverse())
      break
    }
    ordered.push(...ready)
    ready.forEach((name) => remaining.delete(name))
  }
  // Drop dependents before referenced tables because the local D1 shim ignores PRAGMA foreign_keys.
  return ordered.map(
    (name) => `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}";`,
  )
}

const sqlIdentifierPattern =
  '("(?:""|[^"])+"|\\[[^\\]]+\\]|`(?:``|[^`])+`|[^\\s(]+)'

function withoutSqlComments(sql) {
  let result = ''
  let quote = false
  let blockComment = false
  let lineComment = false
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]
    const next = sql[index + 1]
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false
        result += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (char === "'" && next === "'") {
        result += "''"
        index++
      } else if (char === "'") {
        result += char
        quote = false
      }
      continue
    }
    if (char === "'") {
      quote = true
      result += char
    } else if (char === '-' && next === '-') {
      lineComment = true
      index++
    } else if (char === '/' && next === '*') {
      blockComment = true
      index++
    } else result += char
  }
  return result
}

function unquoteSqlIdentifier(identifier) {
  const trimmed = identifier.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1).replaceAll('""', '"')
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return trimmed.slice(1, -1)
  if (trimmed.startsWith('`') && trimmed.endsWith('`'))
    return trimmed.slice(1, -1).replaceAll('``', '`')
  return trimmed
}

export function schemaObjectNames(schemaSql) {
  const objects = new Set()
  const sql = withoutSqlComments(schemaSql)
  const pattern = new RegExp(
    `\\bCREATE\\s+(?:(?:UNIQUE)\\s+)?(TABLE|INDEX|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${sqlIdentifierPattern}`,
    'gi',
  )
  for (const match of sql.matchAll(pattern)) {
    const name = unquoteSqlIdentifier(match[2])
    if (!name.startsWith('sqlite_') && !name.startsWith('_cf_'))
      objects.add(name)
  }
  return objects
}

// withoutSqlComments already drops the contents of string literals, so text
// like RAISE(ABORT, 'cannot CREATE ...') is not counted here.
function schemaCreateCount(schemaSql) {
  return [...withoutSqlComments(schemaSql).matchAll(/\bCREATE\b/gi)].length
}

// Runs before every apply and reset, not only on the comparison path: an
// unsupported declaration would otherwise survive a reset and break the
// following apply with `already exists`.
export function assertSupportedSchema(schema) {
  const declared = schemaCreateCount(schema)
  const parsed = schemaObjectDefinitions(schema).size
  if (declared !== parsed)
    throw setupError(
      'input',
      `apps/web/db/schema.sql has ${declared} CREATE declarations but ${parsed} were understood; only TABLE, INDEX, and TRIGGER are supported`,
    )
}

export function schemaObjectDefinitions(schemaSql) {
  const definitions = new Map()
  const sql = withoutSqlComments(schemaSql)
  const pattern = new RegExp(
    `\\bCREATE\\s+(?:(?:UNIQUE)\\s+)?(TABLE|INDEX|TRIGGER)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${sqlIdentifierPattern})`,
    'gi',
  )
  for (const match of sql.matchAll(pattern)) {
    const end = sqlStatementEnd(sql, match.index, match[1])
    if (end !== -1)
      definitions.set(
        unquoteSqlIdentifier(match[2]),
        normalizeSql(sql.slice(match.index, end)),
      )
  }
  return definitions
}

function sqlStatementEnd(sql, start, type) {
  if (type.toUpperCase() !== 'TRIGGER') return sql.indexOf(';', start)

  const begin = /\bBEGIN\b/gi
  begin.lastIndex = start
  const beginMatch = begin.exec(sql)
  if (!beginMatch) return sql.indexOf(';', start)

  let depth = 1
  const tokens = /\bBEGIN\b|\bEND\b|\bCASE\b|;/gi
  tokens.lastIndex = beginMatch.index + beginMatch[0].length
  for (let token = tokens.exec(sql); token; token = tokens.exec(sql)) {
    if (token[0] === ';') {
      if (depth === 0) return token.index
      continue
    }
    if (['BEGIN', 'CASE'].includes(token[0].toUpperCase())) depth++
    else if (--depth === 0) {
      const terminator = sql.indexOf(';', token.index + token[0].length)
      return terminator
    }
  }
  return -1
}

function runWrangler(args) {
  try {
    return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
      cwd: APP,
      env: { ...process.env, WRANGLER_LOG_PATH: '../../.wrangler/logs' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = [error?.stderr, error?.stdout, error?.message]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw new Error(detail || 'wrangler failed', { cause: error })
  }
}

// The default stays relative because `runWrangler` runs from `apps/web`; an
// explicit value is resolved from where the command was typed instead.
export function configArgs(target, persistTo) {
  const persistArg =
    persistTo === undefined
      ? '.wrangler/state'
      : resolve(process.cwd(), persistTo)
  return target === 'app'
    ? ['-c', 'wrangler.jsonc', '--persist-to', persistArg]
    : ['-c', 'wrangler.sandbox.jsonc', '--persist-to', persistArg]
}

export function tableNames(rows) {
  return rows
    .filter((row) => row.type === 'table')
    .map((row) => row.name)
    .filter(
      (name) => name && !name.startsWith('sqlite_') && !name.startsWith('_cf_'),
    )
}

export function databaseObjectNames(rows) {
  return new Set(
    rows
      .filter(
        (row) =>
          ['table', 'index', 'trigger'].includes(row.type) &&
          row.name &&
          !row.name.startsWith('sqlite_') &&
          !row.name.startsWith('_cf_') &&
          // d1_migrations is managed by Wrangler and is not declared in schema.sql.
          row.name !== 'd1_migrations',
      )
      .map((row) => row.name),
  )
}

function databaseObjects(target, persistTo) {
  const output = runWrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    ...configArgs(target, persistTo),
    '--command',
    "select type, name, sql from sqlite_master where type in ('table', 'index', 'trigger')",
    '--json',
  ])
  const parsed = JSON.parse(output)
  const rows = parsed.flatMap((item) => item.results ?? item.result ?? [])
  return rows
}

function executeFile(target, file, persistTo) {
  runWrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    ...configArgs(target, persistTo),
    '--file',
    file,
  ])
}

export function prepareCerts(dir = join(ROOT, '.dev-certs')) {
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  const hasCert = existsSync(cert)
  const hasKey = existsSync(key)
  if (hasCert && hasKey) return []
  if (hasCert !== hasKey) {
    const existing = hasCert ? cert : key
    const backup = `${existing}.incomplete-${Date.now()}`
    renameSync(existing, backup)
    console.log(`Moved incomplete HTTPS certificate to ${backup}.`)
  }
  mkdirSync(dir, { recursive: true })
  try {
    execFileSync(
      'mkcert',
      [
        '-cert-file',
        cert,
        '-key-file',
        key,
        'localhost',
        '*.localhost',
        '*.sandbox.localhost',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return ['Generated HTTPS certificates with mkcert.']
  } catch (error) {
    if (error?.code !== 'ENOENT')
      throw setupError(
        'input',
        [error?.stderr, error?.stdout, error?.message]
          .filter(Boolean)
          .join('\n')
          .trim() || 'mkcert failed',
        { cause: error },
      )
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '365',
        '-subj',
        '/CN=localhost',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return [
      'Generated self-signed HTTPS certificates with openssl; browsers will show a certificate warning.',
    ]
  }
}

function prepareVars() {
  const vars = join(ROOT, '.dev.vars')
  if (!existsSync(vars)) {
    const example = readFileSync(join(ROOT, '.dev.vars.example'), 'utf8')
    writeFileSync(
      vars,
      example.replace(
        /^BETTER_AUTH_SECRET=.*$/m,
        `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64')}`,
      ),
    )
    return ['Created .dev.vars from .dev.vars.example.']
  }
  const content = readFileSync(vars, 'utf8')
  if (!/^BETTER_AUTH_SECRET=/m.test(content))
    throw setupError(
      'input',
      'Set BETTER_AUTH_SECRET in .dev.vars, then rerun pnpm dev:setup',
    )
  if (!/^BETTER_AUTH_SECRET=.+$/m.test(content))
    throw setupError(
      'input',
      'Set a value for BETTER_AUTH_SECRET in .dev.vars, then rerun pnpm dev:setup',
    )
  return []
}

function prepareDatabase(target, reset, persistTo) {
  const schema = asInput(() => readFileSync(SCHEMA, 'utf8'))
  assertSupportedSchema(schema)
  const existingRows = databaseObjects(target, persistTo)
  const existingTables = tableNames(existingRows)
  const existingObjects = databaseObjectNames(existingRows)
  if (!reset && existingTables.length) {
    const expectedObjects = schemaObjectNames(schema)
    const expectedDefinitions = schemaObjectDefinitions(schema)
    const actualDefinitions = new Map(
      existingRows
        .filter((row) => row.sql)
        .map((row) => [row.name, normalizeDefinition(row.sql)]),
    )
    const missing = [...expectedObjects].filter(
      (name) => !existingObjects.has(name),
    )
    const extra = [...existingObjects].filter(
      (name) => !expectedObjects.has(name),
    )
    const different = [...expectedObjects].filter(
      (name) =>
        existingObjects.has(name) &&
        normalizeDefinition(expectedDefinitions.get(name) ?? '') !==
          (actualDefinitions.get(name) ?? ''),
    )
    if (missing.length || extra.length || different.length)
      throw setupError(
        'reset',
        `Local ${target} D1 schema objects differ; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}; definition differs: ${different.join(', ') || 'none'}; run pnpm dev:setup --reset`,
      )
  }
  if (reset) {
    const directory = mkdtempSync(join(tmpdir(), 'artifactshare-dev-'))
    try {
      const file = join(directory, 'reset.sql')
      const statements = resetStatements(existingRows)
      if (statements.length) {
        writeFileSync(file, statements.join('\n'))
        executeFile(target, file, persistTo)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  if (reset || !existingTables.length) executeFile(target, SCHEMA, persistTo)
  return reset
    ? [`Reset and applied local ${target} D1 schema.`]
    : !existingTables.length
      ? [`Applied local ${target} D1 schema.`]
      : [`Using existing local ${target} D1 schema.`]
}

export function prepareDevEnvironment({
  reset = false,
  target,
  persistTo,
} = {}) {
  let actions = []
  try {
    if (target && !['app', 'sandbox'].includes(target))
      throw setupError(
        'usage',
        `Unknown --target value: ${target}; expected app or sandbox`,
      )
    actions.push(...asInput(prepareCerts))
    actions.push(...asInput(prepareVars))
    const targets = target ? [target] : ['app', 'sandbox']
    // Read the object list per target. app and sandbox share one physical D1,
    // so a snapshot taken before app applies the schema would tell sandbox the
    // tables are still missing and it would apply schema.sql a second time.
    for (const item of targets)
      actions.push(...prepareDatabase(item, reset, persistTo))
    return { ok: true, actions }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // `reset` has no entry in RECOVERY_COMMANDS: both an explicit reset
    // classification and an unclassified failure (a wrangler crash, a locked
    // store) want the same command, which needs the target appended.
    const recovery = error?.recovery ?? 'reset'
    return {
      ok: false,
      actions,
      reason,
      recoveryCommand:
        RECOVERY_COMMANDS[recovery] ??
        `pnpm dev:setup --reset${target ? ` --target ${target}` : ''}${persistTo ? ` --persist-to '${persistTo}'` : ''}`,
    }
  }
}

export function parseCliArgs(args) {
  const targetIndex = args.indexOf('--target')
  const persistIndex = args.indexOf('--persist-to')
  const persistValue = persistIndex === -1 ? undefined : args[persistIndex + 1]
  const targetValue = targetIndex === -1 ? undefined : args[targetIndex + 1]
  // A trailing `--target` would otherwise pass undefined and silently run both.
  const targetMissing = targetIndex !== -1 && !targetValue
  // `--persist-to` takes any string, so a following option would become a
  // directory name; `--target` is checked against an allowlist further down.
  const persistMissing =
    persistIndex !== -1 && (!persistValue || persistValue.startsWith('--'))
  const error =
    targetMissing || persistMissing
      ? {
          ok: false,
          actions: [],
          reason: persistMissing
            ? '--persist-to needs a value: a directory path'
            : '--target needs a value: app or sandbox',
          recoveryCommand: persistMissing
            ? 'pnpm dev:setup --persist-to .wrangler/dev-check'
            : RECOVERY_COMMANDS.usage,
        }
      : undefined
  return {
    error,
    reset: args.includes('--reset'),
    target: targetValue,
    persistTo: persistValue,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    error: argumentError,
    reset,
    target,
    persistTo,
  } = parseCliArgs(process.argv)
  const result =
    argumentError ?? prepareDevEnvironment({ reset, target, persistTo })
  if (result.ok) result.actions.forEach((action) => console.log(action))
  else {
    console.error(result.reason)
    if (result.recoveryCommand) console.error(`Run: ${result.recoveryCommand}`)
    process.exitCode = 1
  }
}
