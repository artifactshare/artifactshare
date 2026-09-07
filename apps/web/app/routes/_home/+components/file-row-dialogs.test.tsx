// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileRowData } from './file-data'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  savingCallbacks: new Map<string, (saving: boolean) => void>(),
}))

vi.mock('react-router', () => ({
  useFetcher: () => ({
    load: mocks.load,
    state: 'idle',
    data: {
      visibility: 'private',
      availableVisibilities: ['private', 'link'],
      grants: [],
      workspaceHd: null,
      projectBaseVisibility: null,
      linkSharingAvailable: true,
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: null,
      linkExpired: false,
    },
  }),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock('../../a.$id/+components/visibility-dialog', () => ({
  VisibilityDialog: ({
    open,
    onOpenChange,
    onSavingChange,
    shareableId,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSavingChange: (saving: boolean) => void
    shareableId: string
  }) => {
    mocks.savingCallbacks.set(shareableId, onSavingChange)
    return (
      <div data-visibility-instance={shareableId} data-open={String(open)}>
        <button type="button" data-save onClick={() => onSavingChange(true)} />
        <button
          type="button"
          data-dismiss
          onClick={() => onOpenChange(false)}
        />
      </div>
    )
  },
}))

import { FileRowDialogs, useFileRowActions } from './file-row-dialogs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const artifactA = { id: 'artifact-a' } as FileRowData
const artifactB = { id: 'artifact-b' } as FileRowData

describe('FileRowDialogs visibility lifetime', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    mocks.load.mockReset()
    mocks.savingCallbacks.clear()
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
  })

  test('unmounts an idle close but preserves a pending same-row instance without reloading', async () => {
    await React.act(async () => root.render(<Harness />))

    await click('[data-open-a]')
    const idleInstance = instance('artifact-a')
    expect(idleInstance).not.toBeNull()
    expect(mocks.load).toHaveBeenCalledTimes(1)
    await click('[data-dismiss]')
    expect(instance('artifact-a')).toBeNull()

    await click('[data-open-a]')
    const pendingInstance = instance('artifact-a')
    expect(mocks.load).toHaveBeenCalledTimes(2)
    await click('[data-save]')
    await click('[data-dismiss]')
    expect(instance('artifact-a')).toBe(pendingInstance)
    expect(pendingInstance?.dataset.open).toBe('false')

    await click('[data-open-a]')
    expect(instance('artifact-a')).toBe(pendingInstance)
    expect(instance('artifact-a')?.dataset.open).toBe('true')
    expect(mocks.load).toHaveBeenCalledTimes(2)
    await click('[data-dismiss]')
    expect(instance('artifact-a')).toBe(pendingInstance)
    expect(instance('artifact-a')?.dataset.open).toBe('false')
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  test('retires an old pending instance without letting its completion clear the new one', async () => {
    await React.act(async () => root.render(<Harness />))
    await click('[data-open-a]')
    await click('[data-save]')
    await click('[data-dismiss]')

    await click('[data-open-b]')
    expect(instance('artifact-a')).toBeNull()
    await click('[data-dismiss]')
    expect(instance('artifact-a')).toBeNull()
    expect(instance('artifact-b')).toBeNull()
    await React.act(async () =>
      mocks.savingCallbacks.get('artifact-a')?.(false),
    )
    expect(instance('artifact-a')).toBeNull()

    await click('[data-open-a]')
    await click('[data-save]')
    await click('[data-dismiss]')
    await click('[data-open-b]')
    await click('[data-save]')
    await click('[data-dismiss]')
    expect(instance('artifact-b')?.dataset.open).toBe('false')

    await React.act(async () =>
      mocks.savingCallbacks.get('artifact-a')?.(false),
    )
    expect(instance('artifact-b')).not.toBeNull()
    await React.act(async () =>
      mocks.savingCallbacks.get('artifact-b')?.(false),
    )
    expect(instance('artifact-b')).toBeNull()
  })

  test('does not let an old same-id completion clear a newer retained save', async () => {
    await React.act(async () => root.render(<Harness />))
    await click('[data-open-a]')
    await click('[data-save]')
    const oldCompletion = mocks.savingCallbacks.get('artifact-a')!
    await click('[data-dismiss]')
    await click('[data-open-b]')
    await click('[data-open-a]')
    await click('[data-save]')
    const currentCompletion = mocks.savingCallbacks.get('artifact-a')!
    await click('[data-dismiss]')

    await React.act(async () => oldCompletion(false))
    expect(instance('artifact-a')).not.toBeNull()
    await React.act(async () => currentCompletion(false))
    expect(instance('artifact-a')).toBeNull()
  })

  function click(selector: string) {
    return React.act(async () => {
      host.querySelector<HTMLButtonElement>(selector)?.click()
    })
  }

  function instance(id: string) {
    return host.querySelector<HTMLElement>(`[data-visibility-instance="${id}"]`)
  }
})

function Harness() {
  const actions = useFileRowActions()
  return (
    <>
      <button
        type="button"
        data-open-a
        onClick={() => actions.open('visibility', artifactA)}
      />
      <button
        type="button"
        data-open-b
        onClick={() => actions.open('visibility', artifactB)}
      />
      <FileRowDialogs active={actions.active} onClose={actions.close} />
    </>
  )
}
