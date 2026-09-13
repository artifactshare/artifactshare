import { tasks } from './task-ledger.mjs'
import type { TaskLedgerScreenReference } from './task-ledger-screen-references'

function acceptsScreenReference(
  reference: TaskLedgerScreenReference,
): TaskLedgerScreenReference {
  return reference
}

const referenceFromLedger: TaskLedgerScreenReference =
  tasks[0].flow[0].screens[0]
acceptsScreenReference(referenceFromLedger)
acceptsScreenReference('home/default')
acceptsScreenReference('viewer/comments-open')

// @ts-expect-error — the screen id must be one of the ScreenSpec exports.
acceptsScreenReference('missing/default')
// @ts-expect-error — the state id must belong to the referenced screen.
acceptsScreenReference('home/content-rich')
// @ts-expect-error — the state id must be declared by the referenced screen.
acceptsScreenReference('viewer/missing')
