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
    })
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await React.act(async () => {
      responses.get('')?.(
        Response.json({
          projects: Array.from({ length: 9 }, (_, index) => ({
            id: `project-${index}`,
            name: `Project ${index}`,
            baseVisibility: 'workspace',
            updatedAt: '2026-08-22T00:00:00.000Z',
          })),
          preferredProject: null,
          nextCursor: null,
        }),
      )
      await Promise.resolve()
    })
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
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
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(responses.has('new')).toBe(true)
    await React.act(async () => {
      responses.get('new')?.(Response.json({ projects: [], nextCursor: null }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('projectPicker.noMatches')
  })

  test('shows a small workspace as buttons and defaults to the preferred project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          projects: [
            {
              id: 'internal-project-id-2',
              name: 'Documentation',
              baseVisibility: 'private',
              updatedAt: '2026-08-22T00:00:00.000Z',
            },
          ],
          preferredProject: {
            id: 'internal-project-id-1',
            name: 'Design review',
            baseVisibility: 'workspace',
            updatedAt: '2026-08-23T00:00:00.000Z',
          },
          nextCursor: null,
        }),
      ),
    )
    function Harness() {
      const [value, setValue] =
        React.useState<Parameters<typeof ProjectCandidatePicker>[0]['value']>(
          null,
        )
      return (
        <>
          <label id="project-label" htmlFor="project">
            Destination project
          </label>
          <ProjectCandidatePicker
            id="project"
            ariaLabelledBy="project-label"
            purpose="agent-approval"
            userCode="ABCD1234"
            value={value}
            onChange={setValue}
          />
        </>
      )
    }
    const router = createMemoryRouter([{ path: '/', element: <Harness /> }], {
      initialEntries: ['/'],
    })

    await React.act(async () => {
      root.render(<RouterProvider router={router} />)
    })
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelector('input')).toBeNull()
    const choices = Array.from(container.querySelectorAll('button'))
    expect(choices).toHaveLength(2)
    expect(container.querySelector('#project')).toBe(choices[0])
    expect(choices[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(
      container
        .querySelector('[role="group"]')
        ?.getAttribute('aria-labelledby'),
    ).toBe('project-label')
    expect(container.textContent).toContain('projectPicker.preferred')
    expect(container.textContent).not.toContain('internal-project-id')
  })

  test('closes search results after choosing from a successful retry', async () => {
    vi.useFakeTimers()
    const initialProjects = Array.from({ length: 9 }, (_, index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
      baseVisibility: 'workspace',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }))
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            projects: initialProjects,
            preferredProject: null,
            nextCursor: null,
          }),
        )
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(
          Response.json({
            projects: [
              {
                id: 'project-retried',
                name: 'Retried project',
                baseVisibility: 'workspace',
                updatedAt: '2026-08-22T00:00:00.000Z',
              },
            ],
            preferredProject: null,
            nextCursor: null,
          }),
        ),
    )
    const onChange = vi.fn()
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="project"
              purpose="bot-destination"
              value={null}
              onChange={onChange}
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
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('input')
    expect(input).not.toBeNull()
    await React.act(async () => {
      input?.focus()
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'retry')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.textContent).toContain('projectPicker.error')

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'projectPicker.retry',
    )
    await React.act(async () => {
      retry?.click()
      await vi.advanceTimersByTimeAsync(250)
    })

    const option = Array.from(
      container.querySelectorAll('[role="option"]'),
    ).find((element) => element.textContent?.includes('Retried project'))
    expect(option).toBeDefined()
    await React.act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-retried' }),
    )
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  test('offers project creation in a new tab when the workspace is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          projects: [],
          preferredProject: null,
          nextCursor: null,
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
    })
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const create = container.querySelector<HTMLAnchorElement>(
      'a[href="/projects?create=1"]',
    )
    expect(create?.target).toBe('_blank')
    expect(container.textContent).toContain('projectPicker.emptyTitle')
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

  test('keeps retry available when an empty-state retry fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          projects: [],
          preferredProject: null,
          nextCursor: null,
        }),
      )
      .mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
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

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'projectPicker.retry',
    )
    expect(retry).toBeDefined()

    await React.act(async () => {
      retry?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('projectPicker.error')
    expect(container.textContent).toContain('projectPicker.retry')
  })
})
