import { readFileSync } from 'node:fs'

const reviewContract = [
  'Review only. Do not edit files, run tests, write to remote services, or start another review.',
  'Read AGENTS.md and docs/reference/development-constraints.md from this fixed public checkout before classifying findings; safe mode does not supply automatic repository instructions.',
  'Report concrete reachable wrong behavior or a broken current acceptance criterion. Distinguish preferences and future generalization from present defects.',
  'Do not treat missing context as GO. State what input is missing and return an incomplete result when the supplied context cannot support a decision.',
].join('\n')

function readImplementationContext(path) {
  if (!path) return ''
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Implementation review context could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!content.trim())
    throw new Error('Implementation review context must be nonempty text.')
  return content
}

function implementationReviewInstructions({
  context = '',
  base,
  expectedHead,
} = {}) {
  return [
    reviewContract,
    `Fixed review base SHA: ${base ?? '<missing>'}`,
    `Expected review HEAD SHA: ${expectedHead ?? '<missing>'}`,
    'The base and expected HEAD above are fixed. Check HEAD before starting and stop if it differs; review the exact base-to-HEAD change.',
    '--- CURRENT CHANGE CONTEXT ---',
    context ||
      '<missing context: the coordinator must supply this before a final gate can start>',
    '--- END CURRENT CHANGE CONTEXT ---',
  ].join('\n\n')
}

export {
  implementationReviewInstructions,
  readImplementationContext,
  reviewContract,
}
