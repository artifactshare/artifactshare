import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createArgumentParser } from './args.js'
import { commandOptionCatalog, generateCliHelp } from './cli.js'
const { insertDefaultSubcommand, commandNameFromArgv, normalizeArgvForGunshi } =
  createArgumentParser(commandOptionCatalog())

test('preview <file> gains the default subcommand', () => {
  assert.deepEqual(insertDefaultSubcommand(['preview', './lp.html']), [
    'preview',
    'start',
    './lp.html',
  ])
})

test('a value flag before preview does not hide the command', () => {
  assert.deepEqual(
    insertDefaultSubcommand(['--profile', 'work', 'preview', './lp.html']),
    ['--profile', 'work', 'preview', 'start', './lp.html'],
  )
  assert.deepEqual(
    insertDefaultSubcommand(['--base-url=https://x.test', 'preview', 'a.md']),
    ['--base-url=https://x.test', 'preview', 'start', 'a.md'],
  )
})

test('explicit subcommands are left alone', () => {
  for (const sub of ['start', 'next', 'done', 'reply', 'stop']) {
    assert.deepEqual(insertDefaultSubcommand(['preview', sub, './lp.html']), [
      'preview',
      sub,
      './lp.html',
    ])
  }
  assert.deepEqual(
    insertDefaultSubcommand(['preview', 'next', '--wait', '90']),
    ['preview', 'next', '--wait', '90'],
  )
})

test('preview without a positional keeps the parent command', () => {
  // `preview --help` must still list the subcommands, and bare `preview` must
  // still report that one is required.
  assert.deepEqual(insertDefaultSubcommand(['preview', '--help']), [
    'preview',
    '--help',
  ])
  assert.deepEqual(insertDefaultSubcommand(['preview']), ['preview'])
})

test('other commands are untouched', () => {
  assert.deepEqual(insertDefaultSubcommand(['share', './lp.html']), [
    'share',
    './lp.html',
  ])
  assert.deepEqual(insertDefaultSubcommand([]), [])
})

test('artifacts delete is canonicalized without losing nested normalization', () => {
  for (const argv of [
    ['artifacts', 'delete', 'abc123def4'],
    ['--profile', 'work', 'artifacts', 'delete', 'abc123def4'],
    ['artifacts', '--profile=work', 'delete', 'abc123def4'],
  ]) {
    assert.equal(commandNameFromArgv(argv), 'delete')
    const normalized = normalizeArgvForGunshi(argv, 'artifacts')
    assert.deepEqual(normalized.slice(0, 2), ['artifacts', 'delete'])
    assert.equal(normalized.at(-1), 'abc123def4')
    assert.deepEqual(
      normalized.slice(2),
      argv.filter((token) => token !== 'artifacts' && token !== 'delete'),
    )
  }
  assert.equal(commandNameFromArgv(['artifacts', 'get']), 'artifacts get')
  assert.equal(commandNameFromArgv(['artifacts', 'list']), 'artifacts list')
})

const catalog = commandOptionCatalog()
const parser = createArgumentParser(catalog)

test('every defined option spelling passes command-specific raw validation', () => {
  for (const [command, options] of catalog) {
    for (const [spelling, option] of options) {
      const argv = [
        ...command.split(' ').filter(Boolean),
        spelling,
        ...(option.boolean ? [] : ['v1']),
      ]
      assert.equal(
        parser.validateRawArgs(argv, parser.commandNameFromArgv(argv)),
        null,
        `${command} ${spelling}`,
      )
    }
  }
})

test('raw validation respects values, repetitions, booleans and the terminator', () => {
  for (const argv of [
    [
      'share',
      '--expectedVersion=v1',
      '--grant-email=one@example.test',
      '--grant-email',
      'two@example.test',
    ],
    ['comments', 'post', '--body', '- a bullet', '--json'],
    ['comments', 'post', '--body', '--unknown-content', '--json'],
    ['edit', '--title=', '--', '--visiblity'],
    ['--profile', 'work', 'share', '--no-slack-notify', '--json'],
  ]) {
    const joined = parser.joinLeadingDashValues(argv)
    assert.equal(
      parser.validateRawArgs(joined, parser.commandNameFromArgv(joined)),
      null,
    )
  }
  assert.deepEqual(
    parser.joinLeadingDashValues(['share', '--', '--body', '-text']),
    ['share', '--', '--body', '-text'],
  )
  for (const argv of [
    ['share', '--json=true'],
    ['share', '--expectedVersion='],
    ['share', '--expected-version', '--json'],
  ]) {
    assert.equal(
      parser.validateRawArgs(argv, 'share')?.code,
      'validation_failed',
    )
  }
  assert.equal(
    parser.validateRawArgs(['whoami', '-x'], 'whoami')?.code,
    'unknown_option',
  )
})

test('unknown option suggestions are command-specific and never contain values', () => {
  const error = parser.validateRawArgs(
    ['share', '--visiblity=private'],
    'share',
  )
  assert.equal(error?.code, 'unknown_option')
  assert.deepEqual(error?.details, { option: '--visiblity' })
  assert.match(error!.hint, /--visibility/)
  assert.doesNotMatch(JSON.stringify(error), /private/)
  assert.doesNotMatch(
    parser.validateRawArgs(['whoami', '--visiblity'], 'whoami')!.hint,
    /--visibility/,
  )
})

test('unrelated short options do not suggest short help or version flags', () => {
  const error = parser.validateRawArgs(['whoami', '-x'], 'whoami')
  assert.equal(error?.code, 'unknown_option')
  assert.doesNotMatch(error!.hint, /Did you mean/)
})

test('every option advertised in command help is accepted by its catalog', async () => {
  for (const [command, options] of catalog) {
    const help = await generateCliHelp(command.split(' ').filter(Boolean))
    const optionLines = help.split('OPTIONS:')[1]?.split(/\n[A-Z ]+:/)[0] ?? ''
    const spellings = [...optionLines.matchAll(/^\s+(?:-\w,\s+)?(--[\w-]+)/gm)]
    assert.ok(spellings.length > 0, command || 'root')
    for (const [, spelling] of spellings) {
      assert.ok(options.has(spelling!), `${command} ${spelling}`)
    }
  }
})

test('every command accepts shared flags except import-token token input', () => {
  for (const [command, options] of catalog) {
    for (const spelling of [
      '--json',
      '--base-url',
      '--baseUrl',
      '--profile',
      '--allow-plaintext-token-store',
      '--allowPlaintextTokenStore',
      '--insecure-localhost',
      '--insecureLocalhost',
      '--token',
    ]) {
      assert.equal(
        options.has(spelling),
        command !== 'profiles import-token' || spelling !== '--token',
        `${command} ${spelling}`,
      )
    }
  }
})

test('only artifacts get gives the long version flag a value', () => {
  assert.equal(catalog.get('artifacts get')?.get('--version')?.boolean, false)
  assert.equal(catalog.get('artifacts get')?.get('-v')?.boolean, true)
  for (const command of ['', 'open', 'update', 'download']) {
    assert.equal(catalog.get(command)?.get('--version')?.boolean, true)
  }
  assert.equal(
    parser.validateRawArgs(
      ['artifacts', 'get', 'abc123def4', '--version=v1'],
      'artifacts get',
    ),
    null,
  )
  assert.equal(
    parser.validateRawArgs(
      ['artifacts', 'get', 'abc123def4', '--version= '],
      'artifacts get',
    )?.code,
    'validation_failed',
  )
})
