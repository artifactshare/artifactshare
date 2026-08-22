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
    React.act(() => root.unmount())
    container.remove()
  })

  test('loads candidates through the route loader and appends the next page', async () => {
    const requests: string[] = []
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
        {
          path: '/api/project-candidates',
          loader: ({ request }) => {
            const url = new URL(request.url)
            requests.push(url.search)
            if (url.searchParams.has('cursor')) {
              return {
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
            }
            return {
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
          },
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
})
