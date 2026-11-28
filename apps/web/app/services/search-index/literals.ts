import { parse, type AnyNode } from 'acorn'

const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

export function jsonStrings(source: string): string {
  const parts: string[] = []
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof RangeError))
      throw error
    return ''
  }
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (japanese.test(current)) parts.push(current)
    } else if (current && typeof current === 'object') {
      const children = Object.values(current)
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index])
    }
  }
  return parts.join(' ')
}

function isNode(value: unknown): value is AnyNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'start' in value &&
    typeof value.start === 'number' &&
    'end' in value &&
    typeof value.end === 'number'
  )
}

export function scriptStrings(source: string): string {
  const sourceTypes: ('script' | 'module')[] = ['script', 'module']
  for (const sourceType of sourceTypes) {
    let program: AnyNode
    try {
      program = parse(source, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
      })
    } catch (error) {
      // Uploaded code controls parser recursion depth. Skip unusable optional
      // scripts so the page's HTML text can still be indexed.
      if (!(error instanceof SyntaxError) && !(error instanceof RangeError))
        throw error
      continue
    }
    const parts: { start: number; value: string }[] = []
    const pending: AnyNode[] = [program]
    while (pending.length > 0) {
      const node = pending.pop()!
      const value =
        node.type === 'Literal'
          ? node.value
          : node.type === 'TemplateElement'
            ? node.value.cooked
            : undefined
      if (typeof value === 'string' && japanese.test(value))
        parts.push({ start: node.start, value })
      for (const child of Object.values(node)) {
        if (isNode(child)) pending.push(child)
        else if (Array.isArray(child)) {
          for (const item of child) if (isNode(item)) pending.push(item)
        }
      }
    }
    // Template quasis and expressions live in separate AST arrays; preserve
    // their original source order, including literals inside interpolations.
    return parts
      .sort((a, b) => a.start - b.start)
      .map((part) => part.value)
      .join(' ')
  }
  return ''
}

// HTML's JavaScript MIME essence types, including legacy aliases.
const javascriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

export function scriptElementStrings(source: string, type: string): string {
  const essence = type.split(';', 1)[0].trim().toLowerCase()
  if (!essence || essence === 'module' || javascriptTypes.has(essence))
    return scriptStrings(source)
  if (
    essence === 'application/json' ||
    essence.endsWith('+json') ||
    essence === 'importmap' ||
    essence === 'speculationrules'
  )
    return jsonStrings(source)
  return source
    .split(/\s+/u)
    .filter((run) => japanese.test(run))
    .join(' ')
}
