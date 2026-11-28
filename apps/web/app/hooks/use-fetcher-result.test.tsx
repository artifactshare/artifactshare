// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useFetcherResult } from './use-fetcher-result'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Result = { ok: boolean }
type FetcherState = 'idle' | 'submitting' | 'loading'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function Probe({
  state,
  data,
  onResult,
}: {
  state: FetcherState
  data?: Result | null
  onResult: (data: Result) => void
}) {
  useFetcherResult({ state, data }, onResult)
  return null
}

async function show(
  state: FetcherState,
  data: Result | null | undefined,
  onResult: (data: Result) => void,
) {
  await act(async () =>
    root.render(<Probe state={state} data={data} onResult={onResult} />),
  )
}

test('a result is handled once, after the fetcher settles', async () => {
  const onResult = vi.fn()
  const saved = { ok: true }

  await show('idle', undefined, onResult)
  await show('idle', null, onResult)
  await show('submitting', undefined, onResult)
  await show('loading', saved, onResult)
  expect(onResult).not.toHaveBeenCalled()

  await show('idle', saved, onResult)
  expect(onResult).toHaveBeenCalledExactlyOnceWith(saved)

  await show('idle', saved, onResult)
  await show('loading', saved, onResult)
  await show('idle', saved, onResult)
  expect(onResult).toHaveBeenCalledTimes(1)
})

test('each new submission result is handled by the latest callback', async () => {
  const first = vi.fn()
  const second = vi.fn()
  const failed = { ok: false }
  const saved = { ok: true }

  await show('idle', failed, first)
  await show('submitting', failed, second)
  await show('idle', saved, second)

  expect(first).toHaveBeenCalledExactlyOnceWith(failed)
  expect(second).toHaveBeenCalledExactlyOnceWith(saved)
})
