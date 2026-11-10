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
  const nothing = (value) =>
    !value ||
    (value.type === 'Identifier' && value.name === 'undefined') ||
    (value.type === 'UnaryExpression' && value.operator === 'void')
  return body.type === 'BlockStatement'
    ? body.body.length === 0 ||
        (body.body.length === 1 &&
          body.body[0].type === 'ReturnStatement' &&
          nothing(body.body[0].argument))
    : nothing(body)
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
export default {
  meta: { name: 'test-reliability' },
  rules: {
    'observed-waits': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        if (
          !/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test|__tests__)\/)/.test(
            context.filename.replaceAll('\\', '/'),
          )
        )
          return {}
        const source = context.sourceCode
        return {
          CallExpression(node) {
            const name = member(node.callee)
            if (
              name === 'catch' &&
              mandatory(node.callee.object) &&
              silent(node.arguments[0])
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
            // Narrow to Playwright sleep calls. Timers in fixtures and fake-clock
            // tests are not automatically synchronization sleeps.
            if (name === 'waitForTimeout') {
              const comments = source.getCommentsBefore(
                node.parent?.type === 'AwaitExpression'
                  ? node.parent.parent
                  : node,
              )
              if (
                !comments.some((comment) =>
                  /test-wait: elapsed-time\s*[—:-]\s*\S.+/.test(comment.value),
                )
              )
                context.report({
                  node,
                  message:
                    'Wait for an observed condition, or document this elapsed-time contract with test-wait: elapsed-time — reason.',
                })
            }
          },
        }
      },
    },
  },
}
