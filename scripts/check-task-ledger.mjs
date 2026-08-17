import { screens } from './screen-ledger.mjs'
import {
  changeProcedure,
  selectionCriteria,
  taskFlowPhases,
  taskLoopStages,
  tasks,
} from './task-ledger.mjs'

const requiredTextFields = [
  'id',
  'title',
  'actor',
  'startingSituation',
  'prerequisite',
  'goal',
  'completion',
  'confirmation',
  'metric',
]

function screenReferences(ledgerScreens) {
  const references = new Set()
  for (const screen of ledgerScreens)
    for (const state of screen.states)
      references.add(`${screen.id}/${state.id}`)
  return references
}

export function checkTaskLedger({
  ledgerTasks = tasks,
  ledgerScreens = screens,
  criteria = selectionCriteria,
  procedure = changeProcedure,
} = {}) {
  const failures = []
  const ids = new Set()
  const validReferences = screenReferences(ledgerScreens)

  if (!Array.isArray(criteria) || criteria.length === 0)
    failures.push('selection criteria required')
  if (!Array.isArray(procedure) || procedure.length === 0)
    failures.push('change procedure required')
  if (ledgerTasks.length < 8 || ledgerTasks.length > 12)
    failures.push(`expected 8-12 primary tasks, found ${ledgerTasks.length}`)

  for (const task of ledgerTasks) {
    const label = task.id || '<missing-id>'
    for (const field of requiredTextFields)
      if (typeof task[field] !== 'string' || !task[field].trim())
        failures.push(`${label}: ${field} required`)

    if (ids.has(task.id)) failures.push(`${label}: duplicate task id`)
    ids.add(task.id)

    if (!taskLoopStages.has(task.loopStage))
      failures.push(`${label}: invalid loop stage ${task.loopStage}`)

    if (!Array.isArray(task.flow)) {
      failures.push(`${label}: flow required`)
      continue
    }
    const phases = task.flow.map((state) => state.phase)
    if (
      phases.length !== taskFlowPhases.length ||
      phases.some((phase, index) => phase !== taskFlowPhases[index])
    )
      failures.push(
        `${label}: flow phases must be ${taskFlowPhases.join(', ')}`,
      )

    for (const state of task.flow) {
      if (typeof state.description !== 'string' || !state.description.trim())
        failures.push(`${label}/${state.phase}: description required`)
      if (!Array.isArray(state.screens) || state.screens.length === 0) {
        failures.push(`${label}/${state.phase}: screen references required`)
        continue
      }
      for (const reference of state.screens)
        if (!validReferences.has(reference))
          failures.push(
            `${label}/${state.phase}: unknown screen reference ${reference}`,
          )
    }
  }

  return failures
}

if (import.meta.main) {
  const failures = checkTaskLedger()
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(
    `task-ledger check ok: ${tasks.length} tasks, ${selectionCriteria.length} selection criteria, ${changeProcedure.length} change steps`,
  )
}
