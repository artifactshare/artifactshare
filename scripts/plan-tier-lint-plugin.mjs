import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const PLAN_NAME_FILES =
  /(?:^|\/)(?:billing|pricing|plan-card|plan-tier|upgrade-request)[^/]*$/u

const DENY = [
  /[pP]lan\s*(?:[!=]==?|=|<>)\s*['"](?:plus|team)['"]/gu,
  /['"](?:plus|team)['"]\s*[!=]==?\s*[\w.?]*[pP]lan\b/gu,
  /\bplan\s+(?:not\s+)?in\s*\(/giu,
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
