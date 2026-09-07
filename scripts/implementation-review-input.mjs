import { readFileSync } from 'node:fs'

const reviewContract = [
  'Review only. Do not edit files, run tests, write to remote services, or start another review.',
  'Read AGENTS.md and docs/reference/development-constraints.md from this fixed public checkout before classifying findings; safe mode does not supply automatic repository instructions.',
  'Report concrete reachable wrong behavior or a broken current acceptance criterion. Distinguish preferences and future generalization from present defects.',
  'Do not treat missing context as GO. State what input is missing and return an incomplete result when the supplied context cannot support a decision.',
].join('\n')

const dispositionsContract =
  "The context contains a Dispositions section listing prior findings and their outcomes. Do not re-raise a dispositioned finding, and do not report the reversal of a previous round's accepted fix, unless you supply a new failure scenario that the disposition did not consider."

const DISPOSITIONS_HEADING = /^#{1,6}[ \t]+.*dispositions?\b/imu

const CONTEXT_DELIMITERS = [
  '--- CURRENT CHANGE CONTEXT ---',
  '--- END CURRENT CHANGE CONTEXT ---',
]
// One outcome per prior finding, in the workflow's vocabulary.
const DISPOSITION_LINE =
  /^\s*[-*]\s+\**(fixed|deferred|non[-_]actionable|follow[-_]up|none yet)\b/iu
const LIST_LINE = /^\s*[-*]\s+/u

/** Lines of the Dispositions section that do not start with an outcome. */
function invalidDispositionLines(content) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => DISPOSITIONS_HEADING.test(line))
  if (start === -1) return []
  const level = (lines[start].match(/^#+/u) ?? [''])[0].length
  const invalid = []
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^(#+)\s/u)
    if (heading && heading[1].length <= level) break
    if (!LIST_LINE.test(line)) continue
    if (!DISPOSITION_LINE.test(line)) invalid.push(line.trim())
  }
  return invalid
}

function assertImplementationContext(content) {
  if (!content.trim())
    throw new Error('Implementation review context must be nonempty text.')
  if (!DISPOSITIONS_HEADING.test(content))
    throw new Error(
      'Implementation review context must contain a "## Dispositions" section listing prior findings and their outcomes (write "None yet" on the first round).',
    )
  const delimiter = CONTEXT_DELIMITERS.find((marker) =>
    content.includes(marker),
  )
  if (delimiter)
    throw new Error(
      `Implementation review context must not contain the delimiter "${delimiter}".`,
    )
  const invalid = invalidDispositionLines(content)
  if (invalid.length > 0)
    throw new Error(
      `Every item under Dispositions must start with fixed, deferred, non-actionable, or follow-up; offending lines: ${invalid.slice(0, 3).join(' | ')}`,
    )
  return content
}

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
  return assertImplementationContext(content)
}

function implementationReviewInstructions({
  context = '',
  base,
  expectedHead,
} = {}) {
  return [
    reviewContract,
    ...(DISPOSITIONS_HEADING.test(context) ? [dispositionsContract] : []),
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
  assertImplementationContext,
  invalidDispositionLines,
  dispositionsContract,
  implementationReviewInstructions,
  readImplementationContext,
  reviewContract,
}
