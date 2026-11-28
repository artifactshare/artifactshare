import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const root = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_ROOTS = ['apps/web/app', 'apps/web/workers']
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
])
const EXCLUDED_DIRECTORIES = new Set([
  '.react-router',
  'build',
  'dist',
  'node_modules',
  'test',
  'tests',
])
const LINT_FIXTURE_DIRECTORY =
  /^apps\/web\/app\/(?:(?:analytics|module-boundary|plan-tier)-lint-fixture-[^/]+|modules\/module-boundary-lint-fixture-[^/]+)$/
const SET_OPERATION_WORDS = new Set(['EXCEPT', 'INTERSECT', 'UNION'])
const SET_OPERATION_METHODS = new Set([
  'except',
  'exceptAll',
  'intersect',
  'intersectAll',
  'union',
  'unionAll',
])
const SET_OPERATION_SEPARATOR = /\b(?:except|intersect|union)(?:\s+all)?\b/i

function isProductionSource(name) {
  return (
    SOURCE_EXTENSIONS.has(extname(name)) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
  )
}

function filesUnder(directory, relativeDirectory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const relativePath = `${relativeDirectory}/${entry.name}`
      return EXCLUDED_DIRECTORIES.has(entry.name) ||
        LINT_FIXTURE_DIRECTORY.test(relativePath)
        ? []
        : filesUnder(path, relativePath)
    }
    return isProductionSource(entry.name) ? [path] : []
  })
}

export function productionSourceFiles(scanRoot = root) {
  return SOURCE_ROOTS.flatMap((directory) =>
    filesUnder(join(scanRoot, directory), directory),
  ).sort()
}

function propertyName(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  return null
}

function combine(left, right) {
  if (!left || !right) return null
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
}

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSDeclareFunction',
])

function patternNames(node, names) {
  if (!node || typeof node !== 'object') return names
  if (Array.isArray(node)) {
    for (const child of node) patternNames(child, names)
    return names
  }
  if (node.type === 'Identifier') names.add(node.name)
  else if (node.type === 'ObjectPattern') patternNames(node.properties, names)
  else if (node.type === 'ArrayPattern') patternNames(node.elements, names)
  else if (node.type === 'Property') patternNames(node.value, names)
  else if (node.type === 'RestElement') patternNames(node.argument, names)
  else if (node.type === 'AssignmentPattern') patternNames(node.left, names)
  else if (node.type === 'TSParameterProperty')
    patternNames(node.parameter, names)
  return names
}

function hoistedVarNames(functionNode, names) {
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (FUNCTION_TYPES.has(node.type)) return
    if (node.type === 'VariableDeclaration' && node.kind === 'var')
      for (const declarator of node.declarations)
        patternNames(declarator.id, names)
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'type'].includes(key)) continue
      visit(child)
    }
  }
  visit(functionNode.body)
  return names
}

function createScope(parent) {
  const bindings = new Map()
  const scope = { bindings, parent }
  scope.lookup = (name) => {
    for (let current = scope; current; current = current.parent) {
      const binding = current.bindings.get(name)
      if (binding) return binding
    }
    return undefined
  }
  return scope
}

function declare(scope, name, init = null) {
  scope.bindings.set(
    name,
    scope.bindings.has(name) ? { init: null, scope } : { init, scope },
  )
}

function declarePattern(scope, node) {
  for (const name of patternNames(node, new Set())) declare(scope, name)
}

function declareStatement(scope, statement) {
  const node = ['ExportDefaultDeclaration', 'ExportNamedDeclaration'].includes(
    statement?.type,
  )
    ? statement.declaration
    : statement
  if (node?.type === 'VariableDeclaration') {
    for (const declarator of node.declarations)
      if (
        node.kind === 'const' &&
        declarator.id?.type === 'Identifier' &&
        declarator.init
      )
        declare(scope, declarator.id.name, declarator.init)
      else declarePattern(scope, declarator.id)
    return
  }
  if (node?.type === 'ImportDeclaration')
    for (const specifier of node.specifiers ?? [])
      declarePattern(scope, specifier.local)
  else if (
    ['ClassDeclaration', 'FunctionDeclaration', 'TSDeclareFunction'].includes(
      node?.type,
    ) &&
    node.id?.type === 'Identifier'
  )
    declare(scope, node.id.name)
}

function scopeFor(node, parent) {
  if (FUNCTION_TYPES.has(node.type)) {
    const scope = createScope(parent)
    declarePattern(scope, node.params)
    if (node.id?.type === 'Identifier') declare(scope, node.id.name)
    for (const name of hoistedVarNames(node, new Set())) declare(scope, name)
    return scope
  }
  if (node.type === 'CatchClause') {
    const scope = createScope(parent)
    declarePattern(scope, node.param)
    return scope
  }
  if (node.type === 'ClassExpression' && node.id?.type === 'Identifier') {
    const scope = createScope(parent)
    declare(scope, node.id.name)
    return scope
  }
  if (['ForInStatement', 'ForOfStatement'].includes(node.type)) {
    const scope = createScope(parent)
    declareStatement(scope, node.left)
    return scope
  }
  if (node.type === 'ForStatement') {
    const scope = createScope(parent)
    declareStatement(scope, node.init)
    return scope
  }
  const statements = ['BlockStatement', 'Program', 'StaticBlock'].includes(
    node.type,
  )
    ? node.body
    : node.type === 'SwitchCase'
      ? node.consequent
      : undefined
  if (!statements) return parent
  const scope = createScope(parent)
  for (const statement of statements) declareStatement(scope, statement)
  return scope
}

function staticStrings(node, scope, seen = new Set()) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'Literal' && typeof node.value === 'string')
    return [node.value]
  if (node.type === 'Identifier') {
    const binding = scope?.lookup(node.name)
    if (!binding?.init || seen.has(node.name)) return null
    return staticStrings(
      binding.init,
      binding.scope,
      new Set([...seen, node.name]),
    )
  }
  if (node.type === 'BinaryExpression' && node.operator === '+')
    return combine(
      staticStrings(node.left, scope, seen),
      staticStrings(node.right, scope, seen),
    )
  if (node.type === 'ConditionalExpression') {
    const consequent = staticStrings(node.consequent, scope, seen)
    const alternate = staticStrings(node.alternate, scope, seen)
    return consequent && alternate ? [...consequent, ...alternate] : null
  }
  if (node.type !== 'TemplateLiteral') return null
  let values = [node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '']
  for (const [index, expression] of node.expressions.entries()) {
    const substitutions = staticStrings(expression, scope, seen)
    if (!substitutions) return null
    values = combine(values, substitutions) ?? []
    const quasi = node.quasis[index + 1]
    values = values.map(
      (value) => value + (quasi?.value.cooked ?? quasi?.value.raw ?? ''),
    )
  }
  return values
}

function templateShapes(node, scope) {
  const resolved = staticStrings(node, scope)
  if (resolved) return resolved
  const template =
    node?.type === 'TemplateLiteral'
      ? node
      : node?.type === 'Identifier' &&
          scope?.lookup(node.name)?.init?.type === 'TemplateLiteral'
        ? scope.lookup(node.name).init
        : undefined
  if (!template) return null
  return [
    template.quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? '')
      .join(' ? '),
  ]
}

function collectKyselyImports(program) {
  const sqlTags = new Set(['sql'])
  const constructors = new Set()
  const namespaces = new Set()
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source?.value !== 'kysely'
    )
      continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (propertyName(specifier.imported) === 'sql')
          sqlTags.add(specifier.local.name)
        if (propertyName(specifier.imported) === 'Kysely')
          constructors.add(specifier.local.name)
      }
      if (specifier.type === 'ImportNamespaceSpecifier')
        namespaces.add(specifier.local.name)
    }
  }
  return { constructors, namespaces, sqlTags }
}

function isSqlTag(node, imports) {
  if (imports.sqlTags.has(propertyName(node))) return true
  return (
    node?.type === 'MemberExpression' &&
    imports.namespaces.has(propertyName(node.object)) &&
    propertyName(node.property) === 'sql'
  )
}

function isKyselyConstructor(node, imports) {
  if (imports.constructors.has(propertyName(node))) return true
  return (
    node?.type === 'MemberExpression' &&
    imports.namespaces.has(propertyName(node.object)) &&
    propertyName(node.property) === 'Kysely'
  )
}

function hasD1CompatibilityPlugin(options) {
  if (options?.type !== 'ObjectExpression') return false
  const plugins = options.properties.find(
    (property) =>
      property.type === 'Property' && propertyName(property.key) === 'plugins',
  )
  return (
    plugins?.type === 'Property' &&
    plugins.value.type === 'ArrayExpression' &&
    plugins.value.elements.some(
      (element) => propertyName(element) === 'd1CompatibilityPlugin',
    )
  )
}

function sqlShapes(node, imports, scope) {
  if (!node || typeof node !== 'object') return null
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    propertyName(node.callee.property) === 'raw' &&
    isSqlTag(node.callee.object, imports)
  )
    return staticStrings(node.arguments[0], scope)
  if (
    node.type === 'ConditionalExpression' ||
    node.type === 'LogicalExpression'
  ) {
    const left = sqlShapes(
      node.type === 'ConditionalExpression' ? node.consequent : node.left,
      imports,
      scope,
    )
    const right = sqlShapes(
      node.type === 'ConditionalExpression' ? node.alternate : node.right,
      imports,
      scope,
    )
    if (!left && !right) return null
    return [...(left ?? [' ? ']), ...(right ?? [' ? '])]
  }
  if (node.type !== 'TaggedTemplateExpression' || !isSqlTag(node.tag, imports))
    return null
  let values = [
    node.quasi.quasis[0]?.value.cooked ?? node.quasi.quasis[0]?.value.raw ?? '',
  ]
  for (const [index, expression] of node.quasi.expressions.entries()) {
    values =
      combine(
        values,
        sqlShapes(expression, imports, scope) ??
          staticStrings(expression, scope) ?? [' ? '],
      ) ?? []
    const quasi = node.quasi.quasis[index + 1]
    values = values.map(
      (value) => value + (quasi?.value.cooked ?? quasi?.value.raw ?? ''),
    )
  }
  return values
}

function tokenizeSql(sql) {
  const tokens = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '-' && next === '-') {
      index = sql.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char
      index += 1
      while (index < sql.length) {
        if (sql[index] !== closing) {
          index += 1
          continue
        }
        if (sql[index + 1] === closing) {
          index += 2
          continue
        }
        index += 1
        break
      }
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index
      index += 1
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1
      tokens.push({
        type: 'word',
        value: sql.slice(start, index).toUpperCase(),
      })
      continue
    }
    if ('();'.includes(char)) tokens.push({ type: char, value: char })
    index += 1
  }
  return tokens
}

function sqlFindings(sql) {
  const findings = []
  const operationCounts = [0]
  for (const token of tokenizeSql(sql)) {
    if (token.type === '(') {
      operationCounts.push(0)
      continue
    }
    if (token.type === ')') {
      operationCounts.pop()
      continue
    }
    if (token.type === ';' && operationCounts.length === 1) {
      operationCounts[0] = 0
      continue
    }
    if (token.type !== 'word') continue
    if (!SET_OPERATION_WORDS.has(token.value)) continue
    const scope = operationCounts.length - 1
    operationCounts[scope] += 1
    if (
      operationCounts[scope] >= 5 &&
      !findings.includes('compound-term-limit')
    )
      findings.push('compound-term-limit')
  }
  return findings
}

function topLevelSetOperationCount(sql) {
  let depth = 0
  let count = 0
  for (const token of tokenizeSql(sql)) {
    if (token.type === '(') depth += 1
    else if (token.type === ')') depth -= 1
    else if (
      depth === 0 &&
      token.type === 'word' &&
      SET_OPERATION_WORDS.has(token.value)
    )
      count += 1
  }
  return count
}

function isCompiledSql(node) {
  return (
    node?.type === 'MemberExpression' &&
    propertyName(node.object) === 'compiled' &&
    propertyName(node.property) === 'sql'
  )
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

export function analyzeD1Source(source, filename = 'source.ts') {
  const parsed = parseSync(filename, source)
  const imports = collectKyselyImports(parsed.program)
  const violations = parsed.errors.map((error) => ({
    line: 1,
    rule: 'parse-error',
    message: `oxc-parser could not analyze this file: ${error.message}`,
  }))
  const analyzedRanges = new Set()

  function report(node, rule, message) {
    violations.push({ line: lineAt(source, node?.start ?? 0), rule, message })
  }

  function contextFor(ancestors) {
    return {
      setOperationCount: ancestors.filter(
        (ancestor) =>
          ancestor.type === 'CallExpression' &&
          ancestor.callee?.type === 'MemberExpression' &&
          SET_OPERATION_METHODS.has(propertyName(ancestor.callee.property)),
      ).length,
    }
  }

  function analyzeSql(node, alternatives, context = {}) {
    const range = `${node.start}:${node.end}`
    if (analyzedRanges.has(range)) return
    analyzedRanges.add(range)
    const findings = new Set(alternatives.flatMap(sqlFindings))
    if (
      context.setOperationCount &&
      alternatives.some(
        (sql) =>
          topLevelSetOperationCount(sql) + context.setOperationCount >= 5,
      )
    )
      findings.add('compound-term-limit')
    if (findings.has('compound-term-limit'))
      report(
        node,
        'compound-term-limit',
        'D1 compound SELECTs are limited to five static terms in application queries',
      )
  }

  function visit(node, ancestors = [], scope = undefined) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ancestors, scope)
      return
    }

    if (
      node.type === 'NewExpression' &&
      isKyselyConstructor(node.callee, imports) &&
      !hasD1CompatibilityPlugin(node.arguments[0])
    )
      report(
        node,
        'missing-kysely-d1-guard',
        'Kysely instances must install d1CompatibilityPlugin',
      )

    if (node.type === 'TaggedTemplateExpression' && isSqlTag(node.tag, imports))
      analyzeSql(
        node,
        sqlShapes(node, imports, scope) ?? [''],
        contextFor(ancestors),
      )

    if (node.type === 'Property' && propertyName(node.key) === 'sql') {
      const alternatives = templateShapes(node.value, scope)
      if (alternatives) analyzeSql(node.value, alternatives)
    }

    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression'
    ) {
      const method = propertyName(node.callee.property)
      if (method === 'prepare') {
        const alternatives = templateShapes(node.arguments[0], scope)
        if (alternatives)
          analyzeSql(node.arguments[0], alternatives, contextFor(ancestors))
        else if (!isCompiledSql(node.arguments[0]))
          report(
            node.arguments[0] ?? node,
            'dynamic-raw-sql',
            'direct D1 prepare() SQL must be directly analyzable',
          )
      }
      if (method === 'raw' && isSqlTag(node.callee.object, imports)) {
        const alternatives = staticStrings(node.arguments[0], scope)
        if (alternatives)
          analyzeSql(node.arguments[0], alternatives, contextFor(ancestors))
        else
          report(
            node.arguments[0] ?? node,
            'dynamic-raw-sql',
            'sql.raw() SQL must be statically analyzable',
          )
      }
      if (method === 'join') {
        const isSqlJoin = isSqlTag(node.callee.object, imports)
        const separatorNode = node.arguments[isSqlJoin ? 1 : 0]
        if (!(isSqlJoin && !separatorNode)) {
          const separators = isSqlJoin
            ? sqlShapes(separatorNode, imports, scope)
            : staticStrings(separatorNode, scope)
          if (isSqlJoin && !separators)
            report(
              node,
              'dynamic-compound-select',
              'sql.join() separators must be directly analyzable',
            )
          else if (
            separators?.some((separator) =>
              SET_OPERATION_SEPARATOR.test(separator),
            )
          )
            report(
              node,
              'dynamic-compound-select',
              'do not generate compound SELECT terms with join(); keep the number of terms statically visible',
            )
        }
      }
    }

    const nextAncestors = [...ancestors, node]
    const nextScope = scopeFor(node, scope)
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'type'].includes(key)) continue
      visit(child, nextAncestors, nextScope)
    }
  }

  visit(parsed.program)
  return violations
}

export function findD1CompatibilityViolations(scanRoot = root) {
  return productionSourceFiles(scanRoot).flatMap((file) =>
    analyzeD1Source(readFileSync(file, 'utf8'), relative(scanRoot, file)).map(
      (violation) => ({ file: relative(scanRoot, file), ...violation }),
    ),
  )
}

if (import.meta.main) {
  const scanRoot = process.argv[2] ?? root
  const violations = findD1CompatibilityViolations(scanRoot)
  for (const violation of violations)
    console.error(
      `${violation.file}:${violation.line}: [${violation.rule}] ${violation.message}`,
    )
  if (violations.length) process.exitCode = 1
  else
    console.log(
      `D1 compatibility check ok: ${productionSourceFiles(scanRoot).length} production source files`,
    )
}
