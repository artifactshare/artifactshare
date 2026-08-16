import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import {
  prepareDevEnvironment,
  prepareCerts,
  databaseObjectNames,
  resetStatements,
  schemaObjectDefinitions,
  schemaObjectNames,
  assertSupportedSchema,
  normalizeDefinition,
  configArgs,
  DEV_SERVICES,
  parseCliArgs,
  selectMissingDevServices,
  serviceIdentityMatches,
} from './dev-setup.mjs'

test('dev launcher reuses healthy services and starts only missing siblings', async () => {
  const { missing, reused } = await selectMissingDevServices(
    DEV_SERVICES,
    ({ name }) => name === 'app',
  )

  assert.deepEqual(
    reused.map(({ name }) => name),
    ['app'],
  )
  assert.deepEqual(
    missing.map(({ name }) => name),
    ['og-image', 'sandbox'],
  )
})

test('dev launcher starts the complete topology when no service is running', async () => {
  const { missing, reused } = await selectMissingDevServices(
    DEV_SERVICES,
    () => false,
  )

  assert.equal(reused.length, 0)
  assert.deepEqual(
    missing.map(({ name }) => name),
    ['og-image', 'app', 'sandbox'],
  )
})

test('dev launcher accepts only the expected service identity', () => {
  const expected = {
    status: 200,
    contentType: 'text/html',
    body: 'Local dev sign-in',
  }

  assert.equal(
    serviceIdentityMatches(expected, {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Local dev sign-in</h1>',
    }),
    true,
  )
  assert.equal(
    serviceIdentityMatches(expected, {
      status: 200,
      contentType: 'text/html',
      body: '<h1>Another application</h1>',
    }),
    false,
  )
})

test('configArgs uses the shared default persist directory', () => {
  assert.deepEqual(configArgs('app'), [
    '-c',
    'wrangler.jsonc',
    '--persist-to',
    '.wrangler/state',
  ])
  assert.deepEqual(configArgs('sandbox'), [
    '-c',
    'wrangler.sandbox.jsonc',
    '--persist-to',
    '.wrangler/state',
  ])
})

test('configArgs resolves an explicit persist directory from cwd', () => {
  assert.equal(
    configArgs('app', 'tmp/check')[3],
    resolve(process.cwd(), 'tmp/check'),
  )
})

test('configArgs resolves an explicitly provided default-looking persist directory', () => {
  assert.notEqual(configArgs('app', '.wrangler/state')[3], configArgs('app')[3])
  assert.equal(
    configArgs('app', '.wrangler/state')[3],
    resolve(process.cwd(), '.wrangler/state'),
  )
})

test('resetStatements uses database DDL for dependency order', () => {
  assert.deepEqual(
    resetStatements([
      {
        type: 'table',
        name: 'workspaces',
        sql: 'CREATE TABLE workspaces (id TEXT);',
      },
      {
        type: 'table',
        name: 'users',
        sql: 'CREATE TABLE users (workspace_id TEXT REFERENCES workspaces(id));',
      },
    ]),
    ['DROP TABLE IF EXISTS "users";', 'DROP TABLE IF EXISTS "workspaces";'],
  )
})

test('resetStatements puts users before workspaces for the application schema', () => {
  const schema = readFileSync(
    new URL('../apps/web/db/schema.sql', import.meta.url),
    'utf8',
  )
  const statements = resetStatements([
    {
      type: 'table',
      name: 'workspaces',
      sql: 'CREATE TABLE workspaces (id TEXT);',
    },
    {
      type: 'table',
      name: 'users',
      sql: 'CREATE TABLE users (workspace_id TEXT REFERENCES workspaces(id));',
    },
  ])
  assert.ok(
    statements.indexOf('DROP TABLE IF EXISTS "users";') <
      statements.indexOf('DROP TABLE IF EXISTS "workspaces";'),
  )
})

test('resetStatements reverses declaration order when dependencies cycle', () => {
  const schema =
    'CREATE TABLE first (other TEXT REFERENCES second(id)); CREATE TABLE second (other TEXT REFERENCES first(id));'
  assert.deepEqual(
    resetStatements([
      { type: 'table', name: 'first', sql: schema.split(';')[0] + ';' },
      { type: 'table', name: 'second', sql: schema.split(';')[1] + ';' },
    ]),
    ['DROP TABLE IF EXISTS "second";', 'DROP TABLE IF EXISTS "first";'],
  )
})

test('resetStatements ignores REFERENCES inside comments in stored DDL', () => {
  // SQLite keeps comments in sqlite_master.sql; a note must not create an edge.
  assert.deepEqual(
    resetStatements([
      {
        type: 'table',
        name: 'workspaces',
        sql: 'CREATE TABLE workspaces (\n  id TEXT -- REFERENCES users(id) は廃止\n);',
      },
      {
        type: 'table',
        name: 'users',
        sql: 'CREATE TABLE users (workspace_id TEXT REFERENCES workspaces(id));',
      },
    ]),
    ['DROP TABLE IF EXISTS "users";', 'DROP TABLE IF EXISTS "workspaces";'],
  )
})

test('schemaObjectNames extracts declarations without comments or body text', () => {
  assert.deepEqual(
    schemaObjectNames(`
      -- CREATE TABLE commented_out (id TEXT);
      CREATE TABLE IF NOT EXISTS users (id TEXT, note TEXT);
      CREATE UNIQUE INDEX users_email ON users(email);
      CREATE INDEX users_name ON users(name);
      CREATE TRIGGER users_audit AFTER INSERT ON users BEGIN
        SELECT 'CREATE TABLE fake (id TEXT)';
      END;
      /* CREATE TRIGGER also_commented ... */
    `),
    new Set(['users', 'users_email', 'users_name', 'users_audit']),
  )
})

test('schema parsing keeps declarations after comment markers in string literals', () => {
  const schema = `
    CREATE TRIGGER guard BEFORE INSERT ON users BEGIN
      SELECT RAISE(ABORT, 'cannot do this -- see docs /* example */');
    END;
    CREATE TABLE after_trigger (id TEXT);
  `
  assert.equal(schemaObjectNames(schema).has('after_trigger'), true)
  assert.equal(schemaObjectDefinitions(schema).has('after_trigger'), true)
})

test('schemaObjectNames includes known objects from the application schema', () => {
  const schema = schemaObjectNames(
    readFileSync(new URL('../apps/web/db/schema.sql', import.meta.url), 'utf8'),
  )
  assert.equal(schema.has('users'), true)
  assert.equal(schema.has('shareables'), true)
  assert.equal(schema.has('workspaces_stripe_subscription_id'), true)
})

test('databaseObjectNames detects missing and extra names by set difference', () => {
  const expected = new Set(['users', 'users_email'])
  const actual = databaseObjectNames([
    { type: 'table', name: 'users' },
    { type: 'index', name: 'users_name' },
    { type: 'table', name: 'd1_migrations' },
  ])
  assert.deepEqual(
    [...expected].filter((name) => !actual.has(name)),
    ['users_email'],
  )
  assert.deepEqual(
    [...actual].filter((name) => !expected.has(name)),
    ['users_name'],
  )
})

test('schema definition normalization detects added columns', () => {
  const expected = schemaObjectDefinitions(
    'CREATE TABLE users (id TEXT, name TEXT);',
  ).get('users')
  const actual = schemaObjectDefinitions(
    'CREATE TABLE users (id TEXT, name TEXT, email TEXT);',
  ).get('users')
  assert.notEqual(expected.replace(/\s+/g, ' '), actual.replace(/\s+/g, ' '))
})

test('normalizeDefinition matches what SQLite stores', () => {
  // SQLite drops IF NOT EXISTS and upper-cases the leading keywords, with or
  // without IF NOT EXISTS present in the source.
  assert.equal(
    normalizeDefinition('CREATE TABLE IF NOT EXISTS users (id TEXT)'),
    'CREATE TABLE users (id TEXT)',
  )
  assert.equal(
    normalizeDefinition('create table users (id TEXT)'),
    'CREATE TABLE users (id TEXT)',
  )
  assert.equal(
    normalizeDefinition(
      'create  unique   index if not exists users_i on users(id)',
    ),
    'CREATE UNIQUE INDEX users_i on users(id)',
  )
})

test('assertSupportedSchema rejects declarations it cannot parse', () => {
  assert.throws(
    () =>
      assertSupportedSchema(
        'CREATE TABLE users (id TEXT); CREATE VIEW active AS SELECT * FROM users;',
      ),
    (error) =>
      error.recovery === 'input' &&
      /only TABLE, INDEX, and TRIGGER are supported/.test(error.message),
  )
})

test('assertSupportedSchema ignores CREATE inside string literals', () => {
  assertSupportedSchema(
    `CREATE TABLE users (id TEXT);
     CREATE TRIGGER users_guard BEFORE DELETE ON users
     BEGIN SELECT RAISE(ABORT, 'cannot CREATE another one'); END;`,
  )
})

test('assertSupportedSchema accepts the real schema', () =>
  assertSupportedSchema(
    readFileSync(new URL('../apps/web/db/schema.sql', import.meta.url), 'utf8'),
  ))

test('schemaObjectDefinitions keeps trigger bodies together', () => {
  const definitions = schemaObjectDefinitions(`
    CREATE TRIGGER audit AFTER INSERT ON users
    BEGIN
      SELECT 'body; BEGIN END';
      INSERT INTO audit_log VALUES (NEW.id);
    END;
  `)
  assert.equal(definitions.size, 1)
  assert.match(definitions.get('audit'), /INSERT INTO audit_log/)
})

test('application schema definitions match every declared object', () => {
  const schema = readFileSync(
    new URL('../apps/web/db/schema.sql', import.meta.url),
    'utf8',
  )
  const names = schemaObjectNames(schema)
  const definitions = schemaObjectDefinitions(schema)
  assert.equal(definitions.size, names.size)
  assert.deepEqual([...definitions.keys()].sort(), [...names].sort())
})

test('application schema includes complete definitions for all triggers', () => {
  const schema = readFileSync(
    new URL('../apps/web/db/schema.sql', import.meta.url),
    'utf8',
  )
  const definitions = schemaObjectDefinitions(schema)
  for (const name of [
    'project_share_defaults_project_only_insert',
    'project_share_defaults_project_only_update',
    'artifact_containers_no_delete_with_shareables',
  ]) {
    assert.match(definitions.get(name), /BEGIN[\s\S]+END$/)
  }
})

test('an argument mistake is not answered with a reset', () => {
  const result = prepareDevEnvironment({ target: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /Unknown --target value: nope/)
  // The hint must not echo the rejected value back at the caller.
  assert.equal(result.recoveryCommand.includes('nope'), false)
  assert.equal(result.recoveryCommand.includes('--reset'), false)
})

test('a failing mkcert keeps its output and the error it came from', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-dev-certs-'))
  const stub = join(directory, 'bin')
  const executable = join(stub, 'mkcert')
  const path = process.env.PATH
  try {
    mkdirSync(stub, { recursive: true })
    writeFileSync(
      executable,
      '#!/bin/sh\necho "mkcert: failed to load the CA key" >&2\nexit 1\n',
    )
    chmodSync(executable, 0o755)
    process.env.PATH = `${stub}${delimiter}${path}`
    assert.throws(
      () => prepareCerts(join(directory, '.dev-certs')),
      (error) =>
        error.recovery === 'input' &&
        /failed to load the CA key/.test(error.message) &&
        /failed to load the CA key/.test(error.cause?.stderr ?? ''),
    )
  } finally {
    process.env.PATH = path
    rmSync(directory, { recursive: true, force: true })
  }
})

test('running the script directly prints the recovery command', () => {
  // --target is rejected before any certificate, .dev.vars, or D1 work starts,
  // and --persist-to keeps the daily apps/web/.wrangler/state out of reach if
  // that order ever changes (docs/reference/local-dev-harness.md).
  const persistTo = mkdtempSync(join(tmpdir(), 'artifactshare-dev-setup-cli-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'dev-setup.mjs'),
        '--target',
        'nope',
        '--persist-to',
        persistTo,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unknown --target value: nope/)
    assert.match(result.stderr, /^Run: pnpm dev:setup --target app$/m)
  } finally {
    rmSync(persistTo, { recursive: true, force: true })
  }
})

test('parseCliArgs reads the value that follows each option', () => {
  const parsed = parseCliArgs([
    '--reset',
    '--target',
    'app',
    '--persist-to',
    '/tmp/check',
  ])
  assert.equal(parsed.error, undefined)
  assert.deepEqual(
    { reset: parsed.reset, target: parsed.target, persistTo: parsed.persistTo },
    { reset: true, target: 'app', persistTo: '/tmp/check' },
  )
})

test('persist-to option without a value is rejected', () => {
  const { error } = parseCliArgs(['--persist-to', '--reset'])
  assert.equal(error.ok, false)
  assert.match(error.reason, /--persist-to needs a value/)
  assert.equal(error.recoveryCommand.includes('--reset'), false)
  // The printed command has to answer the option that was actually wrong, and
  // it is shown after `Run:`, so a placeholder like <directory> would be read
  // by the shell as a redirection instead of being pasted back.
  assert.match(error.recoveryCommand, /--persist-to \S+$/)
  assert.equal(/[<>]/.test(error.recoveryCommand), false)
})
