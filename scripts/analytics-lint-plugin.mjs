import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const allowed = new Set([
  'apps/web/app/lib/analytics/track.client.ts',
  'apps/web/app/root.tsx',
])

function unwrap(node) {
  while (
    node &&
    [
      'ChainExpression',
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
      'TSSatisfiesExpression',
    ].includes(node.type)
  )
    node = node.expression
  return node
}

function propertyName(node, computed) {
  return computed
    ? node.type === 'Literal'
      ? node.value
      : undefined
    : node.name
}

// Resolve declaration aliases through lexical bindings, so a same-named local
// parameter or variable in another scope does not inherit a sender's identity.
function senderPath(node, source, seen = new Set()) {
  node = unwrap(node)
  if (!node) return []
  if (node.type === 'MemberExpression') {
    return [
      ...senderPath(node.object, source, seen),
      propertyName(node.property, node.computed),
    ]
  }
  if (node.type !== 'Identifier') return []
  let scope = source.getScope(node)
  while (scope && !scope.set.has(node.name)) scope = scope.upper
  const variable = scope?.set.get(node.name)
  if (!variable) return [node.name]
  if (seen.has(variable)) return []
  seen.add(variable)
  for (const definition of variable.defs) {
    if (definition.type !== 'Variable' || !definition.node.init) continue
    const declaration = definition.node
    if (declaration.id.type === 'Identifier')
      return senderPath(declaration.init, source, seen)
    if (declaration.id.type === 'ObjectPattern') {
      const property = declaration.id.properties.find(
        (entry) =>
          entry.type === 'Property' &&
          entry.value.type === 'Identifier' &&
          entry.value.name === node.name,
      )
      if (property)
        return [
          ...senderPath(declaration.init, source, seen),
          propertyName(property.key, property.computed),
        ]
    }
  }
  return []
}

export default {
  meta: { name: 'analytics' },
  rules: {
    'typed-sender': {
      meta: { schema: [] },
      create(context) {
        const file = relative(root, context.filename).replaceAll('\\', '/')
        if (
          !file.startsWith('apps/web/app/') ||
          !/\.tsx?$/.test(file) ||
          /\.test\.tsx?$/.test(file) ||
          allowed.has(file)
        )
          return {}
        return {
          CallExpression(node) {
            // Direct calls and embedded snippets remain covered by the text
            // scan; this visitor handles extracted function aliases only.
            const callee = unwrap(node.callee)
            if (callee?.type !== 'Identifier') return
            const path = senderPath(callee, context.sourceCode)
            const command = unwrap(node.arguments[0])
            if (
              (path.at(-1) === 'gtag' &&
                command?.type === 'Literal' &&
                command.value === 'event') ||
              (path.at(-2) === 'dataLayer' && path.at(-1) === 'push')
            )
              context.report({
                node,
                message:
                  'Use the typed trackEvent sender for analytics events.',
              })
          },
          Program() {
            // Preserve the retired checker's text scan, including embedded tag
            // snippets and comments. The suffix match includes window/globalThis
            // and receiver aliases, with quoted properties, optional access, and
            // closing parentheses around direct callees.
            const source = context.sourceCode
            const deny =
              /gtag(?:['"]\s*\])?(?:\s*\))*\s*\??\.?\s*\(\s*(['"])event\1|dataLayer(?:['"]\s*\])?\s*(?:\??\.\s*push|(?:\?\.)?\s*\[\s*(['"])push\2\s*\])/g
            for (const match of source.text.matchAll(deny)) {
              context.report({
                loc: {
                  start: source.getLocFromIndex(match.index),
                  end: source.getLocFromIndex(match.index + match[0].length),
                },
                message:
                  'Use the typed trackEvent sender for analytics events.',
              })
            }
          },
        }
      },
    },
  },
}
