import type { MoveDestinationsResult } from '~/services/shareables.server'

export type MoveDestinations = Extract<MoveDestinationsResult, { kind: 'ok' }>

export interface MoveShareableDialogState {
  destinations: MoveDestinations | null
  query: string
  selected: string | null
  loading: boolean
  loadFailed: boolean
  submitting: boolean
}

export type MoveShareableDialogAction =
  | { type: 'opened' }
  | { type: 'loaded'; destinations: MoveDestinations }
  | { type: 'load-failed' }
  | { type: 'select'; value: string }
  | { type: 'set-query'; value: string }
  | { type: 'set-submitting'; submitting: boolean }

export const INBOX_VALUE = 'inbox'

export function createMoveShareableDialogState(): MoveShareableDialogState {
  return {
    destinations: null,
    query: '',
    selected: null,
    loading: false,
    loadFailed: false,
    submitting: false,
  }
}

export function moveShareableDialogReducer(
  state: MoveShareableDialogState,
  action: MoveShareableDialogAction,
): MoveShareableDialogState {
  switch (action.type) {
    case 'opened':
      return {
        ...state,
        destinations: null,
        query: '',
        selected: null,
        loading: true,
        loadFailed: false,
        submitting: false,
      }
    case 'loaded':
      return {
        ...state,
        destinations: action.destinations,
        loading: false,
        loadFailed: false,
      }
    case 'load-failed':
      return { ...state, destinations: null, loading: false, loadFailed: true }
    case 'select':
      return { ...state, selected: action.value }
    case 'set-query':
      return { ...state, query: action.value }
    case 'set-submitting':
      return { ...state, submitting: action.submitting }
  }
}

export function isMoveDestinations(value: unknown): value is MoveDestinations {
  if (!value || typeof value !== 'object') return false
  return (value as { kind?: unknown }).kind === 'ok'
}

export function getFilteredMoveProjects(
  destinations: MoveDestinations | null,
  query: string,
): MoveDestinations['projects'] {
  const normalizedQuery = normalizeMoveQuery(query)
  return (
    destinations?.projects.filter((project) =>
      project.name.toLowerCase().includes(normalizedQuery),
    ) ?? []
  )
}

function normalizeMoveQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function getSelectableMoveValues(
  destinations: MoveDestinations | null,
  filteredProjects: MoveDestinations['projects'],
): string[] {
  if (!destinations) return []
  return [
    ...(destinations.inbox === null || destinations.inbox.isCurrent
      ? []
      : [INBOX_VALUE]),
    ...filteredProjects.reduce<string[]>((acc, project) => {
      if (!project.isCurrent) acc.push(project.containerId)
      return acc
    }, []),
  ]
}

export function getEffectiveMoveSelection(
  selected: string | null,
  destinations: MoveDestinations | null,
  filteredProjects: MoveDestinations['projects'],
): string | null {
  if (selected === INBOX_VALUE) {
    return destinations?.inbox && !destinations.inbox.isCurrent
      ? selected
      : null
  }
  return filteredProjects.some(
    (project) => !project.isCurrent && project.containerId === selected,
  )
    ? selected
    : null
}

export type MoveAudienceNote =
  | 'unchanged'
  | 'unchangedProject'
  | 'projectPrivateWarning'
  | 'projectWorkspaceWarning'
  | 'projectInboxWarning'

export function getMoveAudienceNote(
  effectiveSelected: string | null,
  filteredProjects: MoveDestinations['projects'],
  isProjectAudience: boolean,
): MoveAudienceNote | null {
  if (!effectiveSelected) return null

  if (!isProjectAudience) {
    return effectiveSelected === INBOX_VALUE ? 'unchanged' : 'unchangedProject'
  }

  if (effectiveSelected === INBOX_VALUE) return 'projectInboxWarning'
  const selectedProject = filteredProjects.find(
    (project) => project.containerId === effectiveSelected,
  )
  if (!selectedProject) return null
  return selectedProject?.baseVisibility === 'workspace'
    ? 'projectWorkspaceWarning'
    : 'projectPrivateWarning'
}
