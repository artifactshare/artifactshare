import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ViewerHistoryPanel } from './viewer-history-panel'

vi.mock('./history-panel', () => ({
  HistoryPanel: (props: {
    publisherManaged?: boolean
    canChangeRetention?: boolean
  }) => (
    <div
      data-managed={String(props.publisherManaged)}
      data-owner={String(props.canChangeRetention)}
    />
  ),
}))

test.each([false, true])(
  'forwards stored management independently of owner controls: %s',
  (owner) => {
    for (const managed of [false, true]) {
      const html = renderToStaticMarkup(
        <ViewerHistoryPanel
          artifact={{
            id: 's1',
            retainVersions: 2,
            publisherManaged: managed,
            canChangeRetention: owner,
            versions: [],
          }}
          state={{
            historyOpen: true,
            chromeCollapsed: false,
            uploading: false,
            dropActive: false,
          }}
          dispatch={() => {}}
          canReplaceFile={false}
          submitReplaceVersion={() => {}}
          replaceMode="single"
          closeAccessRequests={() => {}}
          comments={{ changePanelOpen: () => {} }}
          historyReturnFocusRef={{ current: null }}
          collapseToggleRef={{ current: null }}
        />,
      )
      expect(html).toContain(`data-managed="${managed}"`)
      expect(html).toContain(`data-owner="${owner}"`)
    }
  },
)
