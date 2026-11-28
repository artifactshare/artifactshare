// A file URL's pathname keeps percent-encoding, so a pathname read off
// `new URL('..', import.meta.url)` yields `/home/a%20b/...` in a checkout whose
// path holds a space or a non-ASCII character, and no file system entry matches
// it. fileURLToPath decodes it. The rule reads the AST, so it sees `.pathname`,
// `['pathname']` and `{ pathname }` destructuring, and never a comment or a
// string that spells the shape. A file URL stored in a variable first, then
// read elsewhere, stays out of its reach.
const WRAPPERS = [
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
]

export const MESSAGE =
  'Convert a file URL with fileURLToPath from node:url instead of reading URL.pathname, so a checkout under a path with a space or a non-ASCII character still resolves.'

function unwrap(node) {
  while (node && WRAPPERS.includes(node.type)) node = node.expression
  return node
}

function isImportMetaUrl(node) {
  node = unwrap(node)
  return (
    node?.type === 'MemberExpression' &&
    node.computed === false &&
    node.property?.name === 'url' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta?.name === 'import' &&
    node.object.property?.name === 'meta'
  )
}

// `new URL(relative, import.meta.url)`, and `new URL(import.meta.url)` itself.
function isFileUrl(node) {
  node = unwrap(node)
  return (
    node?.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'URL' &&
    node.arguments.some((argument) => isImportMetaUrl(argument))
  )
}

function isPathnameKey(key, computed) {
  return computed
    ? key?.type === 'Literal' && key.value === 'pathname'
    : key?.type === 'Identifier' && key.name === 'pathname'
}

// An ObjectPattern is the left of a declaration, an assignment or a parameter
// default; each keeps the value it destructures in a different property.
function destructuredValue(pattern) {
  const parent = pattern.parent
  if (parent?.type === 'VariableDeclarator') return parent.init
  if (parent?.type === 'AssignmentExpression') return parent.right
  if (parent?.type === 'AssignmentPattern') return parent.right
  return null
}

export default {
  meta: { name: 'file-url-path' },
  rules: {
    'no-url-pathname': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          MemberExpression(node) {
            if (
              isPathnameKey(node.property, node.computed) &&
              isFileUrl(node.object)
            )
              context.report({ node, message: MESSAGE })
          },
          ObjectPattern(node) {
            if (!isFileUrl(destructuredValue(node))) return
            if (
              node.properties.some(
                (property) =>
                  property.type === 'Property' &&
                  isPathnameKey(property.key, property.computed),
              )
            )
              context.report({ node, message: MESSAGE })
          },
        }
      },
    },
  },
}
