import { describe, expect, test } from 'vitest'
import {
  INBOX_VALUE,
  createMoveShareableDialogState,
  getEffectiveMoveSelection,
  getFilteredMoveProjects,
  getMoveAudienceNote,
  getSelectableMoveValues,
  isMoveDestinations,
  moveShareableDialogReducer,
  type MoveDestinations,
} from './move-shareable-dialog-state'

const destinations: MoveDestinations = {
  kind: 'ok',
  shareable: { id: 's1', title: 'Long title' },
  inbox: { isCurrent: false },
  projects: [
    {
      containerId: 'project-current',
      name: 'Current Project',
      fileCount: 3,
      isCurrent: true,
      baseVisibility: 'workspace',
      externalCount: 0,
    },
    {
      containerId: 'project-a',
      name: 'Northstar Weekly',
      fileCount: 12,
      isCurrent: false,
      baseVisibility: 'private',
      externalCount: 0,
    },
    {
      containerId: 'project-b',
      name: 'Harbor Portal',
      fileCount: 2,
      isCurrent: false,
      baseVisibility: 'workspace',
      externalCount: 0,
    },
  ],
}

describe('moveShareableDialogReducer', () => {
  test('resets query and selection when the dialog opens', () => {
    let state = createMoveShareableDialogState()
    state = moveShareableDialogReducer(state, {
      type: 'loaded',
      destinations,
    })
    state = moveShareableDialogReducer(state, {
      type: 'set-query',
      value: 'active',
    })
    state = moveShareableDialogReducer(state, {
      type: 'select',
      value: 'project-a',
    })

    state = moveShareableDialogReducer(state, { type: 'opened' })

    expect(state.destinations).toBeNull()
    expect(state.query).toBe('')
    expect(state.selected).toBeNull()
    expect(state.loading).toBe(true)
  })
})

describe('move destination view helpers', () => {
  test('keeps current destination out of keyboard selection order', () => {
    const filtered = getFilteredMoveProjects(destinations, '')

    expect(getSelectableMoveValues(destinations, filtered)).toEqual([
      INBOX_VALUE,
      'project-a',
      'project-b',
    ])
  })

  test('does not confirm a selected project hidden by search', () => {
    const filtered = getFilteredMoveProjects(destinations, 'harbor')

    expect(
      getEffectiveMoveSelection('project-a', destinations, filtered),
    ).toBeNull()
    expect(getEffectiveMoveSelection('project-b', destinations, filtered)).toBe(
      'project-b',
    )
  })

  test('does not confirm the current inbox', () => {
    const currentInboxDestinations: MoveDestinations = {
      ...destinations,
      inbox: { isCurrent: true },
    }

    expect(
      getEffectiveMoveSelection(
        INBOX_VALUE,
        currentInboxDestinations,
        getFilteredMoveProjects(currentInboxDestinations, ''),
      ),
    ).toBeNull()
  })

  test('accepts only destination loader data shape', () => {
    expect(isMoveDestinations(destinations)).toBe(true)
    expect(isMoveDestinations({ kind: 'not-found' })).toBe(false)
    expect(isMoveDestinations({ ...destinations, kind: 'error' })).toBe(false)
  })

  test('explains project moves without changing non-project visibility', () => {
    const filtered = getFilteredMoveProjects(destinations, '')

    expect(getMoveAudienceNote('project-a', filtered, false)).toBe(
      'unchangedProject',
    )
    expect(getMoveAudienceNote(INBOX_VALUE, filtered, false)).toBe('unchanged')
  })

  test('warns when project audience changes with the selected destination', () => {
    const filtered = getFilteredMoveProjects(destinations, '')

    expect(getMoveAudienceNote('project-a', filtered, true)).toBe(
      'projectPrivateWarning',
    )
    expect(getMoveAudienceNote('project-b', filtered, true)).toBe(
      'projectWorkspaceWarning',
    )
    expect(getMoveAudienceNote(INBOX_VALUE, filtered, true)).toBe(
      'projectInboxWarning',
    )
  })

  test('does not explain missing or unresolved move selections', () => {
    const filtered = getFilteredMoveProjects(destinations, '')

    expect(getMoveAudienceNote(null, filtered, false)).toBeNull()
    expect(getMoveAudienceNote('missing-project', filtered, true)).toBeNull()
  })
})
