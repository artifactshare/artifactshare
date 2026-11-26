// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { formatRelative } from '~/lib/datetime'
import { RenderClockProvider, useRelativeTime } from './render-clock'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

const renderedAt = '2026-06-02T10:30:00.000Z'
// 30 minutes and 20 seconds before the server render: "30 minutes ago" on the
// server, "31 minutes ago" once the browser's clock is 40 seconds later.
const createdAt = '2026-06-02T09:59:40.000Z'

function Shared() {
  const relativeTime = useRelativeTime()
  return <span>{relativeTime(createdAt, 'en')}</span>
}

function Direct() {
  return <span>{formatRelative(createdAt, 'en')}</span>
}

async function hydrateLater(view: React.ReactElement) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(renderedAt)
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.innerHTML = renderToString(view)
  const serverText = host.textContent
  vi.setSystemTime('2026-06-02T10:30:40.000Z')
  const recoverable = vi.fn()
  await act(async () => {
    root = hydrateRoot(host, view, { onRecoverableError: recoverable })
  })
  return { serverText, recoverable, host }
}

test('relative times hydrate from the server render time, then follow the browser clock', async () => {
  const { serverText, recoverable, host } = await hydrateLater(
    <RenderClockProvider renderedAt={renderedAt}>
      <Shared />
    </RenderClockProvider>,
  )
  expect(serverText).toBe('30 minutes ago')
  expect(recoverable).not.toHaveBeenCalled()
  expect(host.textContent).toBe('31 minutes ago')
})

test('counting from each side’s own clock is what made hydration disagree', async () => {
  const { serverText, recoverable } = await hydrateLater(<Direct />)
  expect(serverText).toBe('30 minutes ago')
  expect(recoverable).toHaveBeenCalled()
})

test('screens format relative times only through useRelativeTime', () => {
  const app = join(import.meta.dirname, '..', '..')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (
        /\.tsx?$/.test(name) &&
        !/\.test\.tsx?$/.test(name) &&
        path !== join(app, 'lib', 'datetime.ts') &&
        path !== join(app, 'components', 'app', 'render-clock.tsx') &&
        /import\s*\{[^}]*\bformatRelative\b[^}]*\}\s*from\s*'~\/lib\/datetime'/.test(
          readFileSync(path, 'utf8'),
        )
      )
        offenders.push(relative(app, path))
    }
  }
  walk(app)
  expect(offenders).toEqual([])
})
