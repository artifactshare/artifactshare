import { createHash } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { rolldown } from 'rolldown'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
export const entryPath = resolve(here, '../src/reporter/entry.ts')
export const outputPath = resolve(here, '../src/reporter.generated.ts')

function fail(reason) {
  throw new Error(`Unsafe reporter bundle: ${reason}`)
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node, ancestors)
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach((child) => walk(child, visit, [...ancestors, node]))
    else if (value && typeof value === 'object')
      walk(value, visit, [...ancestors, node])
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
      node.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression'
    )
      return
    const receiver = node.callee.object
    const method = memberName(node.callee)
    const receiverName =
      receiver.type === 'Identifier' ? receiver.name : memberName(receiver)
    if (
      (receiverName === 'Object' || receiverName === 'Array') &&
      !(identifier(receiver, 'Array') && method === 'isArray')
    )
      fail(
        `${fn.id.name}: uncaptured Object/Array method; use captured primordials`,
      )
    if (
      [
        'forEach',
        'some',
        'map',
        'filter',
        'every',
        'reduce',
        'find',
        'includes',
        'indexOf',
        'join',
        'concat',
      ].includes(method)
    )
      fail(
        `${fn.id.name}: replaceable array method ${method}; use indexed loops and captured primordials`,
      )
  })
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return undefined
  if (!node.computed) return node.property.name
  if (node.property.type === 'Literal') return node.property.value
  if (
    node.property.type === 'TemplateLiteral' &&
    !node.property.expressions.length
  )
    return node.property.quasis[0].value.cooked
  return undefined
}

// Skipped writes and secret handling compare only against live values of
// reporter-owned objects or captured primordials. Do not alias secret state.
// Object-literal shorthand { ctx }, including in call arguments, wraps state
// and is rejected; shorthand binding patterns only declare a local name.
function validateCtxReference(node, ancestors, installReporter) {
  if (!identifier(node, 'ctx')) return
  const parent = ancestors.at(-1)
  const isFunction = (value) =>
    [
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
    ].includes(value?.type)
  if (
    (parent?.type === 'VariableDeclarator' && parent.id === node) ||
    (isFunction(parent) &&
      (parent.id === node || parent.params.includes(node))) ||
    (parent?.type === 'CatchClause' && parent.param === node) ||
    (['ClassDeclaration', 'ClassExpression'].includes(parent?.type) &&
      parent.id === node) ||
    (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(
      parent?.type,
    ) &&
      parent.label === node)
  )
    return
  if (parent?.type === 'MemberExpression' && !parent.computed) return
  if (
    ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(
      parent?.type,
    ) &&
    parent.key === node &&
    !parent.computed &&
    (!parent.shorthand || parent.value !== node)
  )
    return
  // A shorthand key is only a property name. If the parser shares its node
  // with the value, classify that value below rather than exempting it too.
  // Binding patterns are declarations, not value references. Assignment patterns
  // on the left of an assignment remain references and are deliberately rejected.
  let child = node
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const owner = ancestors[index]
    if (owner.type === 'VariableDeclarator' && owner.id === child) return
    if (isFunction(owner) && owner.params.includes(child)) return
    if (owner.type === 'CatchClause' && owner.param === child) return
    if (
      ![
        'Property',
        'ObjectPattern',
        'ArrayPattern',
        'RestElement',
        'AssignmentPattern',
      ].includes(owner.type)
    )
      break
    if (owner.type === 'AssignmentPattern' && owner.left !== child) break
    if (owner.type === 'Property' && owner.value !== child) break
    child = owner
  }
  if (parent?.type === 'CallExpression' && parent.arguments.includes(node))
    return
  if (
    parent?.type === 'ReturnStatement' &&
    parent.argument === node &&
    ancestors.findLast(isFunction) === installReporter
  )
    return
  fail(
    'ctx value reference must be a non-computed member object or direct call argument; only installReporter may return ctx',
  )
}

// Secrets may only be assigned, tested without coercion, or placed directly in
// send's message literal. Reject aliases and serialization, including prototype
// calls, rather than trying to maintain a general-purpose taint analysis. Token
// construction in installReporter is synchronous, before authored code runs.
function validateSecretUse(node, ancestors) {
  if (
    node.type !== 'MemberExpression' ||
    !identifier(node.object, 'ctx') ||
    !['documentToken', 'readyChallenge'].includes(
      node.computed ? node.property.value : node.property.name,
    )
  )
    return
  const parent = ancestors.at(-1)
  if (parent?.type === 'AssignmentExpression' && parent.left === node) return
  if (
    parent?.type === 'BinaryExpression' &&
    ['===', '!=='].includes(parent.operator)
  )
    return
  let value = node
  let index = ancestors.length - 1
  while (ancestors[index]?.type === 'LogicalExpression') {
    value = ancestors[index--]
  }
  if (
    ancestors[index]?.type === 'IfStatement' &&
    ancestors[index].test === value
  )
    return
  const object = ancestors.at(-2)
  const invocation = ancestors.at(-3)
  if (
    parent?.type === 'Property' &&
    parent.value === node &&
    object?.type === 'ObjectExpression' &&
    call(invocation, 'send') &&
    invocation.arguments[1] === object
  )
    return
  fail(
    'private token/challenge must stay out of replaceable calls, coercion, and aliases; use send(ctx, { ... })',
  )
}

// These are the only functions receiving whole secret-bearing messages. Keep
// their calls confined to local copying and the captured native primitives.
// Neither path needs constructors; authored replacements can inspect arguments.
function validateMessageCalls(fn) {
  if (!['send', 'createMessagePayload'].includes(fn.id.name)) return
  walk(fn, (node) => {
    if (node.type === 'NewExpression')
      fail(
        `${fn.id.name}: uncaptured constructor call with private message access; use captured messaging primitives`,
      )
    if (node.type !== 'CallExpression') return
    const callee = node.callee
    if (
      identifier(callee, 'createMessagePayload') ||
      member(callee, 'primitives', 'objectCreate') ||
      member(callee, 'primitives', 'objectKeys') ||
      (callee.type === 'MemberExpression' &&
        member(callee.object, 'ctx', 'primordials') &&
        identifier(callee.property, 'savedPostMessage'))
    )
      return
    fail(
      `${fn.id.name}: uncaptured call with private message access; use captured messaging primitives`,
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
  const ownedStrings = new Set()
  const inertString = (node) =>
    (node?.type === 'Literal' && typeof node.value === 'string') ||
    (node?.type === 'Identifier' && ownedStrings.has(node.name)) ||
    (node?.type === 'BinaryExpression' &&
      node.operator === '+' &&
      inertString(node.left) &&
      inertString(node.right))
  for (const statement of body) {
    if (statement.type === 'FunctionDeclaration') {
      if (securityFunctions.has(statement.id.name))
        validateSecurityFunction(statement)
      validateMessageCalls(statement)
      functions.set(statement.id.name, statement)
      continue
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        const value = declaration.init
        if (
          declaration.id.type !== 'Identifier' ||
          !(
            (value?.type === 'Literal' &&
              ['string', 'number', 'boolean'].includes(typeof value.value)) ||
            (statement.kind === 'const' && inertString(value))
          )
        )
          fail(
            'only inert function/primitive declarations may precede installReporter(window)',
          )
        if (statement.kind === 'const' && inertString(value))
          ownedStrings.add(declaration.id.name)
      }
      continue
    }
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
  walk(program, validateSecretUse)
  walk(program, (node, ancestors) =>
    validateCtxReference(node, ancestors, functions.get('installReporter')),
  )
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
    const source =
      '// Generated by packages/viewer-kit/scripts/build-reporter.mjs. Do not edit.\n' +
      '// Run pnpm --filter @artifactshare/viewer-kit generate:reporter to regenerate.\n' +
      `export const VIOLATION_REPORTER_SCRIPT_BODY = ${JSON.stringify(body)}\n` +
      `export const VIOLATION_REPORTER_SHA256 = ${JSON.stringify(hash)}\n`
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
