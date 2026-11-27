import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// Billing code names plans on purpose: prices, checkout, the plan cards, and
// the plan-to-tier table itself. Everywhere else decides by tier, so a new
// plan joins a tier in one table instead of missing a scattered comparison.
const PLAN_NAME_FILES =
  /(?:^|\/)(?:billing|pricing|plan-card|plan-tier|upgrade-request)[^/]*$/u

// Comparisons that match a plan by a paid plan's name. Matching `free` stays
// allowed: a new paid plan is correctly "not free" without any edit.
const DENY = [
  // TS: `workspace.plan === 'team'`, `observedPlan !== 'plus'`, SQL `plan = 'team'`
  /[pP]lan\s*(?:[!=]==?|=|<>)\s*['"](?:plus|team)['"]/gu,
  // TS: `'team' === workspace.plan`
  /['"](?:plus|team)['"]\s*[!=]==?\s*[\w.?]*[pP]lan\b/gu,
  // SQL: `plan IN ('plus', 'team')`
  /\bplan\s+(?:not\s+)?in\s*\(/giu,
  // Kysely: `.where('workspaces.plan', '=', 'team')`
  /plan['"]\s*,\s*['"](?:=|!=|<>|in|not in)['"]\s*,\s*(?:\[[^\]]*)?['"](?:plus|team)['"]/gu,
]

const MESSAGE =
  'Decide by plan tier (planTier or planInTierSql from ~/lib/plan-tier) instead of comparing plan names, so a new plan cannot silently miss paid or Team features.'

export function isPlanTierScope(file) {
  return (
    /^apps\/web\/(?:app|workers)\//u.test(file) &&
    /\.tsx?$/u.test(file) &&
    !/\.test\.tsx?$/u.test(file) &&
    !/\/(?:test|d1-tests)\//u.test(file) &&
    !PLAN_NAME_FILES.test(file)
  )
}

export function planNameComparisons(text) {
  return DENY.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      index: match.index,
      length: match[0].length,
    })),
  ).sort((a, b) => a.index - b.index)
}

export default {
  meta: { name: 'plan-tier' },
  rules: {
    'no-plan-name-comparison': {
      meta: { schema: [] },
      create(context) {
        const file = relative(root, context.filename).replaceAll('\\', '/')
        if (!isPlanTierScope(file)) return {}
        return {
          Program() {
            const source = context.sourceCode
            for (const { index, length } of planNameComparisons(source.text)) {
              context.report({
                loc: {
                  start: source.getLocFromIndex(index),
                  end: source.getLocFromIndex(index + length),
                },
                message: MESSAGE,
              })
            }
          },
        }
      },
    },
  },
}
