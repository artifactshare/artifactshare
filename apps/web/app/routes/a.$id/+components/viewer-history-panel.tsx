import { HistoryPanel } from './history-panel'
import type { ComponentProps, RefObject } from 'react'
import type { ViewerShellArtifact } from './viewer-shell'

type HistoryProps = ComponentProps<typeof HistoryPanel>
type ViewerHistoryPanelProps = {
  artifact: Pick<
    ViewerShellArtifact,
    | 'id'
    | 'canChangeRetention'
    | 'retainVersions'
    | 'publisherManaged'
    | 'versions'
  >
  state: {
    historyOpen: boolean
    chromeCollapsed: boolean
    uploading: boolean
    dropActive: boolean
  }
  dispatch: (action: { type: 'history-open-changed'; open: boolean }) => void
  canReplaceFile: boolean
  submitReplaceVersion: HistoryProps['onSubmit']
  replaceMode: HistoryProps['replaceMode']
  closeAccessRequests: () => void
  comments: { changePanelOpen: (open: boolean) => void }
  historyReturnFocusRef: RefObject<HTMLElement | null>
  collapseToggleRef: RefObject<HTMLButtonElement | null>
}

export function ViewerHistoryPanel({
  artifact,
  state,
  dispatch,
  canReplaceFile,
  submitReplaceVersion,
  replaceMode,
  closeAccessRequests,
  comments,
  historyReturnFocusRef,
  collapseToggleRef,
}: ViewerHistoryPanelProps) {
  return (
    <HistoryPanel
      artifactId={artifact.id}
      canChangeRetention={artifact.canChangeRetention}
      retainVersions={artifact.retainVersions}
      publisherManaged={artifact.publisherManaged}
      versions={artifact.versions ?? []}
      open={state.historyOpen}
      onOpenChange={(open) => {
        if (open) {
          closeAccessRequests()
          comments.changePanelOpen(false)
        }
        dispatch({ type: 'history-open-changed', open })
      }}
      returnFocusRef={historyReturnFocusRef}
      collapsedFallbackRef={collapseToggleRef}
      topbarCollapsed={state.chromeCollapsed}
      canReplaceFile={canReplaceFile}
      onSubmit={canReplaceFile ? submitReplaceVersion : undefined}
      replaceMode={replaceMode}
      uploading={state.uploading}
      dropActive={state.dropActive}
    />
  )
}
