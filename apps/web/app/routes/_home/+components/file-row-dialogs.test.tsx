// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { FileRowData } from './file-data'
import { useFileRowActions } from './file-row-dialogs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const file = { id: 'artifact-a' } as FileRowData

describe('useFileRowActions', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
  })

  test('retains a closed visibility target for same-row reopen', async () => {
    await React.act(async () => root.render(<Harness />))

    await click('[data-open-visibility]')
    expect(status()).toBe('visibility:artifact-a:true')
    await click('[data-close]')
    expect(status()).toBe('visibility:artifact-a:false')
    await click('[data-open-visibility]')
    expect(status()).toBe('visibility:artifact-a:true')

    await click('[data-open-rename]')
    await click('[data-close]')
    expect(status()).toBe('none')
  })

  function click(selector: string) {
    return React.act(async () => {
      host.querySelector<HTMLButtonElement>(selector)?.click()
    })
  }

  function status() {
    return host.querySelector('[data-status]')?.textContent
  }
})

function Harness() {
  const actions = useFileRowActions()
  return (
    <>
      <button
        type="button"
        data-open-visibility
        onClick={() => actions.open('visibility', file)}
      />
      <button
        type="button"
        data-open-rename
        onClick={() => actions.open('rename', file)}
      />
      <button type="button" data-close onClick={actions.close} />
      <span data-status>
        {actions.active
          ? `${actions.active.action}:${actions.active.file.id}:${String(actions.active.open !== false)}`
          : 'none'}
      </span>
    </>
  )
}
