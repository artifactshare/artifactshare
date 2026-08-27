import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

// Deliberately shallow: this checker inspects SQL written in the same AST
// expression and Kysely wiring. The runtime plugin owns builder/data-flow cases.
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

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : filesUnder(path)
    return isProductionSource(entry.name) ? [path] : []
  })
}

export function productionSourceFiles(scanRoot = root) {
  return SOURCE_ROOTS.flatMap((directory) =>
    filesUnder(join(scanRoot, directory)),
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

function staticStrings(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'Literal' && typeof node.value === 'string')
    return [node.value]
  if (node.type === 'BinaryExpression' && node.operator === '+')
    return combine(staticStrings(node.left), staticStrings(node.right))
  if (node.type === 'ConditionalExpression') {
    const consequent = staticStrings(node.consequent)
    const alternate = staticStrings(node.alternate)
    return consequent && alternate ? [...consequent, ...alternate] : null
  }
  if (node.type !== 'TemplateLiteral') return null
  let values = [node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '']
  for (const [index, expression] of node.expressions.entries()) {
    const substitutions = staticStrings(expression)
    if (!substitutions) return null
    values = combine(values, substitutions) ?? []
    const quasi = node.quasis[index + 1]
    values = values.map(
      (value) => value + (quasi?.value.cooked ?? quasi?.value.raw ?? ''),
    )
  }
  return values
}

function templateShapes(node) {
  const resolved = staticStrings(node)
  if (resolved || node?.type !== 'TemplateLiteral') return resolved
  return [
    node.quasis
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

function sqlShapes(node, imports) {
  if (!node || typeof node !== 'object') return null
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    propertyName(node.callee.property) === 'raw' &&
    isSqlTag(node.callee.object, imports)
  )
    return staticStrings(node.arguments[0])
  if (
    node.type === 'ConditionalExpression' ||
    node.type === 'LogicalExpression'
  ) {
    const left = sqlShapes(
      node.type === 'ConditionalExpression' ? node.consequent : node.left,
      imports,
    )
    const right = sqlShapes(
      node.type === 'ConditionalExpression' ? node.alternate : node.right,
      imports,
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
    values = combine(values, sqlShapes(expression, imports) ?? [' ? ']) ?? []
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
  const existsScopes = []
  const operationCounts = [0]
  let pendingExists = false
  for (const token of tokenizeSql(sql)) {
    if (token.type === '(') {
      existsScopes.push(pendingExists)
      operationCounts.push(0)
      pendingExists = false
      continue
    }
    if (token.type === ')') {
      existsScopes.pop()
      operationCounts.pop()
      pendingExists = false
      continue
    }
    if (token.type === ';' && existsScopes.length === 0) {
      operationCounts[0] = 0
      pendingExists = false
      continue
    }
    if (token.type !== 'word') continue
    if (token.value === 'EXISTS') {
      pendingExists = true
      continue
    }
    if (!SET_OPERATION_WORDS.has(token.value)) {
      pendingExists = false
      continue
    }
    const scope = operationCounts.length - 1
    operationCounts[scope] += 1
    if (existsScopes.includes(true) && !findings.includes('compound-in-exists'))
      findings.push('compound-in-exists')
    if (
      operationCounts[scope] >= 2 &&
      !findings.includes('compound-term-limit')
    )
      findings.push('compound-term-limit')
    pendingExists = false
  }
  return findings
}

function hasSetOperation(sql) {
  return tokenizeSql(sql).some(
    (token) => token.type === 'word' && SET_OPERATION_WORDS.has(token.value),
  )
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

function isInsideMethodCall(ancestors, methods) {
  return ancestors.some(
    (ancestor) =>
      ancestor.type === 'CallExpression' &&
      ancestor.callee?.type === 'MemberExpression' &&
      methods.has(propertyName(ancestor.callee.property)),
  )
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
      insideExists: isInsideMethodCall(ancestors, new Set(['exists'])),
      insideSetOperation: isInsideMethodCall(ancestors, SET_OPERATION_METHODS),
    }
  }

  function analyzeSql(node, alternatives, context = {}) {
    const range = `${node.start}:${node.end}`
    if (analyzedRanges.has(range)) return
    analyzedRanges.add(range)
    const findings = new Set(alternatives.flatMap(sqlFindings))
    if (context.insideExists && alternatives.some(hasSetOperation))
      findings.add('compound-in-exists')
    if (
      context.insideSetOperation &&
      alternatives.some((sql) => topLevelSetOperationCount(sql) > 0)
    )
      findings.add('compound-term-limit')
    if (findings.has('compound-in-exists'))
      report(
        node,
        'compound-in-exists',
        'D1 compound SELECTs are not allowed inside EXISTS; use independent EXISTS predicates',
      )
    if (findings.has('compound-term-limit'))
      report(
        node,
        'compound-term-limit',
        'D1 compound SELECTs are limited to two static terms in application queries',
      )
  }

  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ancestors)
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
      analyzeSql(node, sqlShapes(node, imports) ?? [''], contextFor(ancestors))

    if (node.type === 'Property' && propertyName(node.key) === 'sql') {
      const alternatives = templateShapes(node.value)
      if (alternatives) analyzeSql(node.value, alternatives)
    }

    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression'
    ) {
      const method = propertyName(node.callee.property)
      if (method === 'prepare') {
        const alternatives = templateShapes(node.arguments[0])
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
        const alternatives = staticStrings(node.arguments[0])
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
            ? sqlShapes(separatorNode, imports)
            : staticStrings(separatorNode)
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
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'type'].includes(key)) continue
      visit(child, nextAncestors)
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
