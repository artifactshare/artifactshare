import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const member = (node) =>
  node?.type === 'MemberExpression'
    ? node.computed
      ? node.property.value
      : node.property.name
    : undefined
const unwrap = (node) =>
  node?.type === 'ChainExpression' ? node.expression : node
function mandatory(node) {
  node = unwrap(node)
  if (node?.type !== 'CallExpression') return false
  const name = member(node.callee) ?? node.callee?.name ?? ''
  if (['then', 'catch', 'finally'].includes(name))
    return mandatory(node.callee.object)
  return (
    /^waitFor/.test(name) || /^to[A-Z]/.test(name) || name === 'requiredWait'
  )
}
function silent(callback) {
  if (
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)
  )
    return false
  const body = callback.body
  const discarded = (value) =>
    !value ||
    (value.type === 'Identifier' && value.name === 'undefined') ||
    (value.type === 'Literal' && [null, false].includes(value.value)) ||
    (value.type === 'UnaryExpression' && value.operator === 'void')
  const logging = (value) =>
    value?.type === 'CallExpression' &&
    value.callee?.type === 'MemberExpression' &&
    value.callee.object?.type === 'Identifier' &&
    value.callee.object.name === 'console' &&
    ['log', 'warn', 'error', 'info', 'debug'].includes(member(value.callee))
  return body.type === 'BlockStatement'
    ? body.body.every(
        (statement) =>
          (statement.type === 'ReturnStatement' &&
            (discarded(statement.argument) || logging(statement.argument))) ||
          (statement.type === 'ExpressionStatement' &&
            logging(statement.expression)),
      )
    : discarded(body) || logging(body)
}
function optional(node) {
  node = unwrap(node)
  return (
    !!node &&
    (node.optional ||
      (node.type === 'MemberExpression' && optional(node.object)) ||
      (node.type === 'CallExpression' && optional(node.callee)))
  )
}
function timedSleep(node) {
  if (node.parent?.type !== 'AwaitExpression') return false
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'Promise')
    return false
  const executor = node.arguments[0]
  if (
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(executor?.type)
  )
    return false
  const body = executor.body
  const expressions =
    body.type === 'BlockStatement'
      ? body.body
          .filter((statement) => statement.type === 'ExpressionStatement')
          .map((statement) => statement.expression)
      : [body]
  return expressions.some((expression) => {
    const call = unwrap(expression)
    if (call?.type !== 'CallExpression') return false
    const name = member(call.callee) ?? call.callee?.name
    if (name !== 'setTimeout') return false
    const delay = call.arguments[1]
    return !(delay?.type === 'Literal' && delay.value === 0)
  })
}
const ELAPSED_TIME_MESSAGE =
  'Wait for an observed condition, or document this elapsed-time contract with test-wait: elapsed-time — reason.'
function documentedWait(node, source) {
  let statement = node
  while (
    statement.parent &&
    !['BlockStatement', 'Program'].includes(statement.parent.type)
  )
    statement = statement.parent
  return source
    .getCommentsBefore(statement)
    .some((comment) =>
      /test-wait: elapsed-time\s*[—:-]\s*\S.+/.test(comment.value),
    )
}
export default {
  meta: { name: 'test-reliability' },
  rules: {
    'observed-waits': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const file = relative(root, context.filename).replaceAll('\\', '/')
        const namedTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        const testHelper =
          !file.startsWith('../') && /(?:^|\/)(?:test|__tests__)\//.test(file)
        if (!namedTest && !testHelper) return {}
        const source = context.sourceCode
        return {
          CallExpression(node) {
            const name = member(node.callee)
            if (
              ['catch', 'then'].includes(name) &&
              mandatory(node.callee.object) &&
              silent(node.arguments[name === 'catch' ? 0 : 1])
            )
              context.report({
                node,
                message:
                  'Required waits/assertions must reject; do not silently discard failure.',
              })
            if (
              ['click', 'focus', 'dispatchEvent'].includes(name) &&
              optional(node)
            )
              context.report({
                node,
                message:
                  'Require the test interaction target; optional interaction can silently skip the action.',
              })
            if (name === 'waitForTimeout' && !documentedWait(node, source))
              context.report({ node, message: ELAPSED_TIME_MESSAGE })
          },
          NewExpression(node) {
            if (timedSleep(node) && !documentedWait(node, source))
              context.report({ node, message: ELAPSED_TIME_MESSAGE })
          },
        }
      },
    },
  },
}
