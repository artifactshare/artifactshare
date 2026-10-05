import path from 'node:path'

// Node 24 test:pass/test:fail events carry nesting, name, file and details.
// Node 24 supplies testId/parentId; scope IDs by file for concurrent workers.
export function serializeError(error, seen = new Set()) {
  if (error == null) return null
  if (typeof error !== 'object') return { message: String(error) }
  if (seen.has(error)) return { message: '[circular error]' }
  seen.add(error)
  return {
    message: String(error.message ?? ''),
    stack: String(error.stack ?? ''),
    failureType: error.failureType ?? null,
    cause: serializeError(error.cause, seen),
  }
}

export default async function* reporter(source) {
  const ancestors = new Map()
  const identities = new Map()
  for await (const { type, data } of source) {
    if (type === 'test:stdout' || type === 'test:stderr') {
      process.stderr.write(data.message)
    }
    if (type === 'test:enqueue' || type === 'test:start') {
      if (data.testId !== undefined)
        identities.set(JSON.stringify([data.file, data.testId]), data)
    }
    if (type === 'test:start') {
      const names = ancestors.get(data.file) ?? []
      names.length = data.nesting
      names[data.nesting] = data.name
      ancestors.set(data.file, names)
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue
    const error = serializeError(data.details?.error)
    // Suite and subtest rollups repeat leaf failures. Process failures do not.
    if (
      (data.details?.type === 'suite' && type === 'test:pass') ||
      error?.failureType === 'subtestsFailed'
    )
      continue
    const names = ancestors.get(data.file) ?? []
    const parents = []
    let parent = identities.get(JSON.stringify([data.file, data.parentId]))
    while (parent) {
      parents.unshift(parent.name)
      parent = identities.get(JSON.stringify([data.file, parent.parentId]))
    }
    const fileFailure =
      data.details?.type === 'suite' ||
      (error &&
        data.file &&
        path.resolve(data.name) === path.resolve(data.file))
    const testName = fileFailure
      ? '[file failure]'
      : [
          ...(data.testId === undefined
            ? names.slice(0, data.nesting)
            : parents),
          data.name,
        ].join(' > ')
    yield `${JSON.stringify({
      file: data.file ?? '[suite]',
      testName,
      status:
        data.skip || data.todo
          ? 'skipped'
          : type === 'test:fail'
            ? 'failed'
            : 'passed',
      diagnosticKind: fileFailure ? 'file' : null,
      error,
    })}\n`
  }
  yield `${JSON.stringify({ type: 'complete' })}\n`
}
