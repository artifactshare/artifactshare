import { createHash } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseSync } from 'oxc-parser'
import { rolldown } from 'rolldown'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
export const entryPath = resolve(here, '../src/reporter/entry.ts')
export const outputPath = resolve(here, '../src/reporter.generated.ts')

function fail(reason) {
  throw new Error(`Unsafe reporter bundle: ${reason}`)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit))
    else if (value && typeof value === 'object') walk(value, visit)
  }
}

function identifier(node, name) {
  return node?.type === 'Identifier' && node.name === name
}

function member(node, object, property) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    identifier(node.object, object) &&
    identifier(node.property, property)
  )
}

function call(node, name) {
  return node?.type === 'CallExpression' && identifier(node.callee, name)
}

// These entry points process private messages or trusted-event decisions. Walk
// their entire bodies (including listener callbacks). Unlike the anchor engine
// and painters, the original reporter never used iterable syntax in these paths.
// Keep this list in sync when extracting/renaming security-sensitive functions.
const securityFunctions = new Set([
  'createMessagePayload',
  'send',
  'ready',
  'onReadyCheck',
  'installMessageListener',
  'readEventValue',
  'trusted',
  'prepareLinkClick',
  'finishLinkClick',
  'shouldHandleLink',
  'openExternalLink',
  'isExternallyOpenable',
  'sendSelection',
  'cssPath',
  'selectedElement',
  'anchorRoot',
  'installCspViolations',
  'requestMermaidRendering',
  'installMermaidResults',
])

function validateSecurityFunction(fn) {
  walk(fn, (node) => {
    if (['ForOfStatement', 'SpreadElement', 'ArrayPattern'].includes(node.type))
      fail(
        `${fn.id.name}: ${node.type} can invoke authored iterators; use indexed loops and captured primordials`,
      )
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      (identifier(node.callee.object, 'Object') ||
        (identifier(node.callee.object, 'Array') &&
          !identifier(node.callee.property, 'isArray')))
    )
      fail(
        `${fn.id.name}: uncaptured Object/Array method; use captured primordials`,
      )
  })
}

/** Reject initialization introduced by bundling, not just familiar helper names. */
export function validateBundle(
  output,
  sourceFunctions = new Set(['installReporter', 'capturePrimordials']),
) {
  if (output.length !== 1 || output[0].type !== 'chunk')
    fail('expected exactly one JavaScript chunk and no assets')
  const chunk = output[0]
  if (
    chunk.imports.length ||
    chunk.dynamicImports.length ||
    chunk.exports.length
  )
    fail('imports, dynamic imports, and exports are forbidden')
  const { program, errors } = parseSync('reporter.js', chunk.code)
  if (errors.length) fail(`invalid JavaScript: ${errors[0].message}`)
  const statements = program.body
  const invocation = statements.length === 1 && statements[0].expression
  let wrapper = invocation?.type === 'CallExpression' && invocation.callee
  while (wrapper?.type === 'ParenthesizedExpression')
    wrapper = wrapper.expression
  if (
    !wrapper ||
    !['FunctionExpression', 'ArrowFunctionExpression'].includes(wrapper.type) ||
    invocation.arguments.length ||
    wrapper.params.length ||
    wrapper.body.type !== 'BlockStatement'
  )
    fail('expected one unnamed, argument-free IIFE with no global assignment')
  const body = wrapper.body.body
  if (
    body[0]?.type !== 'ExpressionStatement' ||
    body[0].directive !== 'use strict'
  )
    fail(
      'IIFE must begin with a use strict directive to protect reporter state from caller/arguments access',
    )
  const functions = new Map()
  let installs = 0
  for (const statement of body) {
    if (statement.type === 'FunctionDeclaration') {
      if (securityFunctions.has(statement.id.name))
        validateSecurityFunction(statement)
      functions.set(statement.id.name, statement)
      continue
    }
    if (
      statement.type === 'VariableDeclaration' &&
      statement.declarations.every(
        (declaration) =>
          declaration.id.type === 'Identifier' &&
          declaration.init?.type === 'Literal' &&
          ['string', 'number', 'boolean'].includes(
            typeof declaration.init.value,
          ),
      )
    )
      continue
    if (
      statement.type === 'ExpressionStatement' &&
      statement.directive === 'use strict'
    )
      continue
    if (
      statement.type === 'ExpressionStatement' &&
      call(statement.expression, 'installReporter') &&
      statement.expression.arguments.length === 1 &&
      identifier(statement.expression.arguments[0], 'window')
    ) {
      installs++
      continue
    }
    fail(
      'only inert function/primitive declarations may precede installReporter(window)',
    )
  }
  if (installs !== 1) fail('expected one installReporter(window) call')
  const install = functions.get('installReporter')?.body.body
  const guard = install?.[0]
  if (
    guard?.type !== 'IfStatement' ||
    guard.alternate ||
    guard.test.type !== 'BinaryExpression' ||
    guard.test.operator !== '===' ||
    !member(guard.test.left, 'win', 'parent') ||
    !identifier(guard.test.right, 'win') ||
    guard.consequent.type !== 'ReturnStatement' ||
    guard.consequent.argument
  )
    fail('installReporter must start with the top-level-frame guard')
  const capture = install[1]
  const declaration =
    capture?.type === 'VariableDeclaration' &&
    capture.declarations.length === 1 &&
    capture.declarations[0]
  if (
    !declaration ||
    !call(declaration.init, 'capturePrimordials') ||
    declaration.init.arguments.length !== 1 ||
    !identifier(declaration.init.arguments[0], 'win')
  )
    fail('primordial capture must immediately follow the frame guard')
  const firstCapture = functions.get('capturePrimordials')?.body.body[0]
  if (
    firstCapture?.type !== 'VariableDeclaration' ||
    !member(firstCapture.declarations[0]?.init, 'win', 'parent')
  )
    fail('capturePrimordials must begin by saving the supplied window parent')
  walk(program, (node) => {
    if (
      node.type === 'FunctionDeclaration' &&
      !sourceFunctions.has(node.id.name)
    )
      fail(
        `added function ${node.id.name}; bundling must not introduce runtime helpers`,
      )
    if (
      node.type === 'Identifier' &&
      /^__(?:spread|async|awaiter|generator|commonJS|esm|export|toESM|toCommonJS|copyProps|defProp|name|require)/i.test(
        node.name,
      )
    )
      fail(
        `transform/runtime helper ${node.name}; keep the ES2022 target and native modules`,
      )
    if (/^(?:Import|Export)/.test(node.type))
      fail('runtime module syntax is forbidden')
    if (
      node.type === 'AssignmentExpression' &&
      ['window', 'globalThis', 'self'].some(
        (name) =>
          node.left.type === 'MemberExpression' &&
          identifier(node.left.object, name),
      )
    )
      fail('global assignments are forbidden')
  })
  if (/<\/script/i.test(chunk.code))
    fail('literal closing script tag would end injection early')
  return chunk.code
}

export function formatGenerated(source) {
  const result = spawnSync(
    resolve(here, '../node_modules/.bin/oxfmt'),
    [
      '--config',
      resolve(repository, '.oxfmtrc.json'),
      '--stdin-filepath',
      outputPath,
    ],
    { input: source, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Formatting reporter data failed: ${result.stderr}`)
  return result.stdout
}

export async function renderReporter({ entry = entryPath } = {}) {
  entry = await realpath(entry)
  const bundle = await rolldown({
    input: entry,
    cwd: repository,
    platform: 'browser',
    transform: { target: 'es2022' },
    treeshake: false,
    onwarn(warning) {
      throw new Error(warning.message)
    },
  })
  try {
    const { output } = await bundle.generate({
      format: 'iife',
      // Keep strictness inside the IIFE; a top-level directive would also
      // change the surrounding classic script's scope.
      strict: false,
      intro: '"use strict";',
      minify: false,
      sourcemap: false,
      codeSplitting: false,
      comments: { legal: false },
    })
    const sourceFunctions = new Set()
    if (output.length === 1 && output[0].type === 'chunk') {
      for (const moduleId of Object.keys(output[0].modules)) {
        const reporterDirectory = dirname(entry)
        if (
          !moduleId.startsWith(reporterDirectory + '/') &&
          moduleId !== resolve(reporterDirectory, '../reporter-constants.ts')
        )
          fail(
            `unexpected runtime module ${moduleId}; reporter dependencies must stay self-contained`,
          )
        const source = await readFile(moduleId, 'utf8')
        const parsed = parseSync(moduleId, source)
        if (parsed.errors.length) fail(`invalid reporter source ${moduleId}`)
        walk(parsed.program, (node) => {
          if (node.type === 'FunctionDeclaration' && node.id)
            sourceFunctions.add(node.id.name)
        })
      }
    }
    // Region labels are bundler diagnostics, not injected source. Strip them
    // before hashing so local module paths never become part of the response.
    const body = validateBundle(output, sourceFunctions)
      .replace(/\r\n/g, '\n')
      .replace(/^[ \t]*\/\/#(?:end)?region[^\n]*(?:\n|$)/gm, '')
    const hash = createHash('sha256').update(body, 'utf8').digest('base64')
    const source = formatGenerated(
      '// Generated by packages/viewer-kit/scripts/build-reporter.mjs. Do not edit.\n' +
        '// Run pnpm --filter @artifactshare/viewer-kit generate:reporter to regenerate.\n' +
        `export const VIOLATION_REPORTER_SCRIPT_BODY = ${JSON.stringify(body)}\n` +
        `export const VIOLATION_REPORTER_SHA256 = ${JSON.stringify(hash)}\n`,
    )
    return { body, hash, source }
  } finally {
    await bundle.close()
  }
}

export async function generateReporter({
  entry = entryPath,
  output = outputPath,
  check = false,
} = {}) {
  const rendered = await renderReporter({ entry })
  let existing = null
  try {
    existing = await readFile(output, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (check) {
    if (existing !== rendered.source)
      throw new Error(
        `${output} is missing or stale; run pnpm --filter @artifactshare/viewer-kit generate:reporter`,
      )
  } else if (existing !== rendered.source) {
    await writeFile(output, rendered.source)
  }
  return rendered
}

if (import.meta.main) {
  try {
    const result = await generateReporter({
      check: process.argv.includes('--check'),
    })
    console.log(
      `Reporter ${process.argv.includes('--check') ? 'is current' : 'generated'}: ${Buffer.byteLength(result.body, 'utf8')} UTF-8 bytes`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
