import { readFileSync } from 'node:fs'

const reviewContract = [
  'Review only. Do not edit files, run tests, write to remote services, or start another review.',
  'Read AGENTS.md, CLAUDE.md, and docs/reference/development-constraints.md from the supplied fixed head snapshot before classifying findings; safe mode does not supply automatic repository instructions.',
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
// One outcome per prior finding, in the workflow's vocabulary. Markdown
// emphasis or code marks may precede the outcome; list markers are `-`, `*`,
// `+`, or an ordered `1.`, indented up to three spaces.
const LIST_ITEM = /^( *)(?:[-*+]|\d+[.)])\s+(.*)$/u
const OUTCOME =
  /^[*_`]*(fixed|deferred|non[-_]actionable|follow[-_]up|stop|none yet)\b/iu
// The section itself: a heading whose text starts with "Dispositions". The
// presence check above stays lenient (a title may mention dispositions).
const DISPOSITIONS_SECTION = /^#{1,6}[ \t]+dispositions?\b/iu
const FENCE = /^ {0,3}(```|~~~)/u

/**
 * Every Dispositions section: a heading whose text starts with "Dispositions"
 * (or, when none exists, each level-2+ heading that mentions dispositions),
 * skipping fenced code. Returns [start, end) line ranges of their bodies.
 */
function dispositionsSections(lines) {
  const strictStarts = []
  const lenientStarts = []
  let fenced = false
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    if (DISPOSITIONS_SECTION.test(line)) strictStarts.push(index)
    else if (/^#{2,6}[ \t]/u.test(line) && DISPOSITIONS_HEADING.test(line))
      lenientStarts.push(index)
  })
  // Both forms are checked: a canonical section and the historic
  // "Nth review ... dispositions" headings can coexist in one context.
  const starts = [...strictStarts, ...lenientStarts].sort((a, b) => a - b)
  return starts.map((start) => {
    const level = (lines[start].match(/^#+/u) ?? [''])[0].length
    let end = lines.length
    let inFence = false
    for (let index = start + 1; index < lines.length; index += 1) {
      if (FENCE.test(lines[index])) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const heading = lines[index].match(/^(#+)\s/u)
      if (heading && heading[1].length <= level) {
        end = index
        break
      }
    }
    return [start + 1, end]
  })
}

/** Items of every Dispositions section that do not start with an outcome,
 * plus a marker when a section has no item at all. */
function invalidDispositionLines(content) {
  const lines = content.split(/\r?\n/u)
  const invalid = []
  for (const [start, end] of dispositionsSections(lines)) {
    let items = 0
    let fenced = false
    for (const line of lines.slice(start, end)) {
      if (FENCE.test(line)) {
        fenced = !fenced
        continue
      }
      if (fenced) continue
      const item = line.match(LIST_ITEM)
      if (!item) continue
      // A bullet nested two or more spaces under an item is that item's
      // detail; a list indented by one space is still a list of items.
      if (item[1].length >= 2 && items > 0) continue
      items += 1
      if (!OUTCOME.test(item[2].trim())) invalid.push(line.trim())
    }
    if (items === 0 && !/none yet/iu.test(lines.slice(start, end).join('\n')))
      invalid.push(`(no items under ${lines[start - 1].trim()})`)
  }
  return invalid
}

function assertImplementationContext(content) {
  if (!content.trim())
    throw new Error('Implementation review context must be nonempty text.')
  if (dispositionsSections(content.split(/\r?\n/u)).length === 0)
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
      `Every item under Dispositions must start with fixed, deferred, non-actionable, follow-up, stop, or None yet; offending lines: ${invalid.slice(0, 3).join(' | ')}`,
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
    'The launcher checks the fixed HEAD and clean worktree before and after review. Review the exact base-to-head change using the supplied snapshots and diff; you do not need to inspect Git state.',
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
