export type ViewerListOpenedFrom = 'meta' | 'menu'

export type ViewerListCloseReason = 'user' | 'forced'

interface ViewerShellState {
  chromeCollapsed: boolean
  historyOpen: boolean
  viewerListOpen: boolean
  viewerListCloseReason: ViewerListCloseReason | null
  artifactId: string
  dropActive: boolean
  dropCatcherVisible: boolean
  uploading: boolean
}

type ViewerShellAction =
  | { type: 'chrome-collapsed-changed'; collapsed: boolean }
  | { type: 'history-open-changed'; open: boolean }
  | {
      type: 'viewer-list-open-changed'
      open: boolean
      reason?: ViewerListCloseReason
    }
  | { type: 'artifact-changed'; artifactId: string }
  | { type: 'file-drag-entered' }
  | { type: 'drop-active-changed'; active: boolean }
  | { type: 'drop-finished' }
  | { type: 'uploading-changed'; uploading: boolean }

export function createViewerShellState(artifactId: string): ViewerShellState {
  return {
    chromeCollapsed: false,
    historyOpen: false,
    viewerListOpen: false,
    viewerListCloseReason: null,
    artifactId,
    dropActive: false,
    dropCatcherVisible: false,
    uploading: false,
  }
}

export function viewerShellReducer(
  state: ViewerShellState,
  action: ViewerShellAction,
): ViewerShellState {
  switch (action.type) {
    case 'chrome-collapsed-changed':
      return { ...state, chromeCollapsed: action.collapsed }
    case 'history-open-changed':
      return action.open
        ? {
            ...state,
            historyOpen: true,
            viewerListOpen: false,
            viewerListCloseReason: 'forced',
          }
        : { ...state, historyOpen: false }
    case 'viewer-list-open-changed':
      return action.open
        ? {
            ...state,
            viewerListOpen: true,
            viewerListCloseReason: null,
            historyOpen: false,
          }
        : {
            ...state,
            viewerListOpen: false,
            viewerListCloseReason: action.reason ?? 'user',
          }
    case 'artifact-changed':
      return {
        ...state,
        artifactId: action.artifactId,
        viewerListOpen: false,
        viewerListCloseReason: 'forced',
      }
    case 'file-drag-entered':
      return {
        ...state,
        historyOpen: true,
        viewerListOpen: false,
        viewerListCloseReason: 'forced',
        dropActive: true,
        dropCatcherVisible: true,
      }
    case 'drop-active-changed':
      return { ...state, dropActive: action.active }
    case 'drop-finished':
      return { ...state, dropActive: false, dropCatcherVisible: false }
    case 'uploading-changed':
      return { ...state, uploading: action.uploading }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}
