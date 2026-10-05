import fs from 'node:fs'
import { serializeError } from './node-test-json-reporter.mjs'

function namePath(entity) {
  const names = []
  while (entity.type !== 'module') {
    names.unshift(entity.name)
    entity = entity.parent
  }
  return names
}

// Vitest 4.1.11 exposes VITEST_TEST_PATH on runtime errors and wraps browser
// failures with this exact message, even when collection never created a module.
// Read the structured error, never the human console rendering.
function errorModule(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return null
  seen.add(error)
  if (typeof error.VITEST_TEST_PATH === 'string') return error.VITEST_TEST_PATH
  const prefix = 'Failed to run the test '
  if (error.message?.startsWith(prefix) && error.message.endsWith('.'))
    return error.message.slice(prefix.length, -1)
  return errorModule(error.cause, seen)
}

export function structuredReport(testModules, unhandledErrors, reason) {
  return {
    schemaVersion: 1,
    reason,
    modules: testModules.map((module) => ({
      moduleId: module.moduleId,
      project: module.project.name || null,
      state: module.state(),
      errors: module.errors().map((error) => serializeError(error)),
      suites: [...module.children.allSuites()].map((suite) => ({
        namePath: namePath(suite),
        state: suite.state(),
        errors: suite.errors().map((error) => serializeError(error)),
      })),
      tests: [...module.children.allTests()].map((test) => ({
        namePath: namePath(test),
        state: test.result().state,
        errors: (test.result().errors ?? []).map((error) =>
          serializeError(error),
        ),
      })),
    })),
    unhandledErrors: unhandledErrors.map((error) => ({
      moduleId: errorModule(error),
      error: serializeError(error),
    })),
  }
}

export default class FlakyReporter {
  onInit(ctx) {
    this.output = ctx.config.outputFile
    if (typeof this.output !== 'string')
      throw new Error('Expected --outputFile for flaky reporter')
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    fs.writeFileSync(
      this.output,
      JSON.stringify(structuredReport(testModules, unhandledErrors, reason)),
    )
  }
}
