const SKIPPED_KEYS = new Set([
  'comments',
  'end',
  'loc',
  'parent',
  'range',
  'start',
  'tokens',
  'type',
])

export const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSDeclareFunction',
])

export function propertyName(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  return null
}

export function combine(left, right) {
  if (!left || !right) return null
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix))
}

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
      if (SKIPPED_KEYS.has(key)) continue
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

export function walk(node, enter, ancestors = [], scope = undefined) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, enter, ancestors, scope)
    return
  }
  enter(node, ancestors, scope)
  const nextAncestors = [...ancestors, node]
  const nextScope = scopeFor(node, scope)
  for (const [key, child] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue
    walk(child, enter, nextAncestors, nextScope)
  }
}

export function staticStrings(node, scope, seen = new Set()) {
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

export function templateShapes(node, scope) {
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

export function collectKyselyImports(program) {
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

export function isSqlTag(node, imports) {
  if (imports.sqlTags.has(propertyName(node))) return true
  return (
    node?.type === 'MemberExpression' &&
    imports.namespaces.has(propertyName(node.object)) &&
    propertyName(node.property) === 'sql'
  )
}
