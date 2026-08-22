// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectCandidatePicker } from './project-candidate-picker'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}))

describe('ProjectCandidatePicker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    React.act(() => root.unmount())
    container.remove()
  })

  test('loads candidates and appends the next page', async () => {
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://artifactshare.test')
        requests.push(url.search)
        const page = url.searchParams.has('cursor')
          ? {
              projects: [
                {
                  id: 'project-2',
                  name: 'Second project',
                  baseVisibility: 'private' as const,
                  updatedAt: '2026-08-22T00:00:00.000Z',
                },
              ],
              nextCursor: null,
            }
          : {
              projects: [
                {
                  id: 'project-1',
                  name: 'First project',
                  baseVisibility: 'workspace' as const,
                  updatedAt: '2026-08-22T00:00:00.000Z',
                },
              ],
              nextCursor: 'next-page',
            }
        return Response.json(page)
      }),
    )
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="project"
              purpose="bot-destination"
              value={null}
              onChange={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )

    await React.act(async () => {
      root.render(<RouterProvider router={router} />)
    })
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await React.act(async () => {
      container.querySelector('input')?.focus()
    })

    expect(requests).toEqual(['?purpose=bot-destination&q='])
    expect(container.textContent).toContain('First project')

    const more = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'projectPicker.more',
    )
    expect(more).toBeDefined()
    await React.act(async () => {
      more?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(requests).toEqual([
      '?purpose=bot-destination&q=',
      '?purpose=bot-destination&q=&cursor=next-page',
    ])
    expect(container.textContent).toContain('First project')
    expect(container.textContent).toContain('Second project')
  })

  test('ignores an old response while a changed query is debouncing', async () => {
    vi.useFakeTimers()
    const responses = new Map<string, (value: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            const url = new URL(String(input), 'https://artifactshare.test')
            responses.set(url.searchParams.get('q') ?? '', resolve)
          }),
      ),
    )
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="project"
              purpose="bot-destination"
              value={null}
              onChange={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )

    await React.act(async () => {
      root.render(<RouterProvider router={router} />)
      await vi.advanceTimersByTimeAsync(0)
    })
    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    await React.act(async () => {
      if (!input) return
      input.focus()
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'new')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await React.act(async () => {
      responses.get('')?.(
        Response.json({
          projects: [
            {
              id: 'stale-project',
              name: 'Stale project',
              baseVisibility: 'workspace',
              updatedAt: '2026-08-22T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      )
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Stale project')
    expect(container.textContent).toContain('projectPicker.loading')

    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(responses.has('new')).toBe(true)
    await React.act(async () => {
      responses.get('new')?.(Response.json({ projects: [], nextCursor: null }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('projectPicker.empty')
  })

  test('keeps a transport failure in the picker error state', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="project"
              purpose="bot-destination"
              value={null}
              onChange={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ['/'] },
    )

    await React.act(async () => {
      root.render(<RouterProvider router={router} />)
    })
    await React.act(async () => {
      container.querySelector('input')?.focus()
      await vi.runAllTimersAsync()
    })

    expect(container.textContent).toContain('projectPicker.error')
  })
})
