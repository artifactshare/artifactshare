import type { ComponentProps } from 'react'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const routeData = vi.hoisted(() => ({ locale: 'en' }))

vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate: vi.fn() }),
  useRouteLoaderData: () => routeData,
}))

// The real panel keeps its body behind a sheet, whose portal renders nothing on
// the server. Render the panel's own body instead, forwarding whatever props the
// panel was handed so this test never restates their names.
vi.mock('./history-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./history-panel')>()
  return {
    ...actual,
    HistoryPanel: (props: ComponentProps<typeof actual.HistoryPanel>) => (
      <actual.HistoryPanelBody
        {...props}
        canReplaceFile={props.canReplaceFile ?? false}
        uploading={props.uploading ?? false}
        active={false}
        inputRef={{ current: null }}
        locale="en"
        replaceMode="single"
        setLocalDropActive={() => {}}
        submitFiles={() => {}}
        t={
          ((key: string, vars?: object) =>
            key + (vars ? JSON.stringify(vars) : '')) as never
        }
      />
    ),
  }
})

import { ViewerHistoryPanel } from './viewer-history-panel'

function panelBody(artifact: {
  publisherManaged: boolean
  canChangeRetention: boolean
}) {
  const doc = new Window().document
  doc.body.innerHTML = renderToStaticMarkup(
    <ViewerHistoryPanel
      artifact={{ id: 's1', retainVersions: 2, versions: [], ...artifact }}
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
  return {
    retentionControl: doc.querySelector('button[aria-controls][aria-expanded]'),
    text: doc.body.textContent,
  }
}

test('only an owner gets retention controls', () => {
  for (const publisherManaged of [false, true]) {
    expect(
      panelBody({ publisherManaged, canChangeRetention: false })
        .retentionControl,
    ).toBeNull()
    expect(
      panelBody({ publisherManaged, canChangeRetention: true })
        .retentionControl,
    ).not.toBeNull()
  }
})

test('an owner is told when the publisher manages the stored versions', () => {
  const managed = panelBody({
    publisherManaged: true,
    canChangeRetention: true,
  })
  const unmanaged = panelBody({
    publisherManaged: false,
    canChangeRetention: true,
  })
  expect(managed.text).not.toBe(unmanaged.text)
})
