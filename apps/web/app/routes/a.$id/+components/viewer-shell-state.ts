// ViewerShell の UI 状態 reducer。閲覧者パネル (viewer list) との排他は
// AC 7 に対応する。table テストと browser テストから直接 import できるよう
// viewer-shell.tsx から分離している (viewer-shell が re-export する)。
export type ViewerListOpenedFrom = 'meta' | 'menu'

// user: Esc・閉じるボタン・入口トグルなど利用者操作による閉鎖 (フォーカスを
// 入口へ戻す)。forced: comments/history 排他や artifact 切替による強制閉鎖
// (直後に開くパネルからフォーカスを奪わない)。
export type ViewerListCloseReason = 'user' | 'forced'

interface ViewerShellState {
  chromeCollapsed: boolean
  historyOpen: boolean
  viewerListOpen: boolean
  viewerListOpenedFrom: ViewerListOpenedFrom | null
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
      from?: ViewerListOpenedFrom
      // close (open: false) の理由。省略時は 'user'。
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
    viewerListOpenedFrom: null,
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
      // 履歴と閲覧者パネルは排他 (AC 7)。履歴が開くケースでは閲覧者パネルを閉じる。
      return action.open
        ? {
            ...state,
            historyOpen: true,
            viewerListOpen: false,
            viewerListOpenedFrom: null,
            viewerListCloseReason: 'forced',
          }
        : { ...state, historyOpen: false }
    case 'viewer-list-open-changed':
      return action.open
        ? {
            ...state,
            viewerListOpen: true,
            viewerListOpenedFrom: action.from ?? null,
            viewerListCloseReason: null,
            historyOpen: false,
          }
        : {
            ...state,
            viewerListOpen: false,
            viewerListOpenedFrom: null,
            viewerListCloseReason: action.reason ?? 'user',
          }
    case 'artifact-changed':
      // artifact 切替でパネルを閉じる。取得済みリストの破棄は useViewerList 側の
      // artifactId 照合が担う。
      return {
        ...state,
        artifactId: action.artifactId,
        viewerListOpen: false,
        viewerListOpenedFrom: null,
        viewerListCloseReason: 'forced',
      }
    case 'file-drag-entered':
      return {
        ...state,
        historyOpen: true,
        viewerListOpen: false,
        viewerListOpenedFrom: null,
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
