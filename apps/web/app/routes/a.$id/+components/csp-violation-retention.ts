import type { CspViolationMessage } from '~/lib/csp-reporter'
import { classifyCspViolation } from '~/lib/csp-violation-classification'

const CSP_VIOLATION_LIMIT_PER_GROUP = 100

export function retainCspViolation<T extends CspViolationMessage>(
  entries: readonly T[],
  message: T,
  sandboxOrigin: string,
  renderType: string | null,
): T[] {
  const counts = { artifact: 0, environment: 0, pending: 0 }
  const candidates = [...entries, message]
  const retained: T[] = []
  for (let index = candidates.length - 1; index >= 0; index--) {
    const entry = candidates[index]!
    const classification = classifyCspViolation(
      entry.sourceFile,
      sandboxOrigin,
      renderType,
      entry.blockedURI,
    )
    // Before the type settles, reserve a separate bounded group for CDN
    // sources that could become artifact reports. Markdown never uses it.
    const group =
      renderType === null &&
      classification === 'environment' &&
      classifyCspViolation(
        entry.sourceFile,
        sandboxOrigin,
        'html',
        entry.blockedURI,
      ) === 'artifact'
        ? 'pending'
        : classification
    if (counts[group] >= CSP_VIOLATION_LIMIT_PER_GROUP) continue
    counts[group] += 1
    retained.push(entry)
  }
  return retained.reverse()
}
