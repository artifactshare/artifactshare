import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { commands } from 'vitest/browser'
import '~/app.css'
import { bindI18n } from '~/lib/i18n'
import { ProjectCandidatePicker } from '~/components/app/project-candidate-picker'
import { MoveShareableDialog } from './a.$id/+components/move-shareable-dialog'

const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n: bind } = await import('~/lib/i18n')
  return { useT: () => bind(language.locale) }
})

// Authorization cases use real server queries; the empty-state case below
// separately checks the picker response interaction.
describe('authorized destination responses', () => {
  let root: Root
  let host: HTMLDivElement
  let router: ReturnType<typeof createMemoryRouter>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    router.dispose()
    host.remove()
    vi.unstubAllGlobals()
  })

  test.each(['en', 'ja'] as const)(
    'move offers the retained destination and its audience warning (%s)',
    async (locale) => {
      language.locale = locale
      const destinations = await commands.projectPlacementDestinations(false)
      const control = await commands.projectPlacementDestinations(true)
      if (control.kind !== 'ok') throw new Error('missing control destinations')
      expect(
        control.projects.some(
          (project) => project.containerId === 'unavailable',
        ),
      ).toBe(true)
      let respond!: (value: Response) => void
      const response = new Promise<Response>((resolve) => {
        respond = resolve
      })
      router = createMemoryRouter([
        {
          path: '/',
          element: (
            <MoveShareableDialog
              open
              onOpenChange={() => {}}
              shareableId="artifact"
              shareableTitle="Example"
              homeOwnerName="Owner"
              isProjectAudience
            />
          ),
        },
        {
          path: '/api/shareables/artifact/move',
          loader: () => response,
        },
      ])
      await act(async () => root.render(<RouterProvider router={router} />))
      await act(async () => {
        respond(Response.json(destinations))
      })
      let option: HTMLButtonElement | undefined
      await vi.waitFor(() => {
        option = [
          ...document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
        ].find((node) => node.textContent?.includes('Available destination'))
        expect(option).toBeDefined()
      })
      expect(document.body.textContent).not.toContain('Unavailable destination')
      if (!option) throw new Error('missing retained destination')
      await act(async () => option!.click())
      expect(option.getAttribute('aria-checked')).toBe('true')
      expect(document.body.textContent).toContain(
        bindI18n(locale).t('move.audienceWarnProjectPrivate'),
      )
    },
  )

  test.each([false, true])(
    'candidate picker reflects live destination eligibility (allowOther=%s)',
    async (allowOther) => {
      language.locale = 'en'
      const candidates = await commands.projectPlacementCandidates(allowOther)
      const selected = vi.fn()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(candidates)),
      )
      router = createMemoryRouter([
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="destination"
              purpose="bot-destination"
              value={null}
              onChange={selected}
            />
          ),
        },
      ])
      await act(async () => root.render(<RouterProvider router={router} />))
      await vi.waitFor(() =>
        expect(host.textContent).toContain('Available destination'),
      )
      if (allowOther) {
        const option = [...host.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('Unavailable destination'),
        )
        expect(option).toBeDefined()
        if (!option) throw new Error('missing newly eligible candidate')
        await act(async () => option.click())
        expect(selected).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'unavailable' }),
        )
      } else {
        expect(host.textContent).not.toContain('Unavailable destination')
      }
    },
  )

  test.each([false, true])(
    'candidate picker supports empty and populated responses (empty=%s)',
    async (empty) => {
      language.locale = 'en'
      const selected = vi.fn()
      const project = {
        id: 'allowed',
        name: 'Available destination',
        baseVisibility: 'private',
        updatedAt: '2026-09-17T00:00:00.000Z',
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            projects: empty ? [] : [project],
            preferredProject: null,
            nextCursor: null,
          }),
        ),
      )
      router = createMemoryRouter([
        {
          path: '/',
          element: (
            <ProjectCandidatePicker
              id="destination"
              purpose="bot-destination"
              value={null}
              onChange={selected}
            />
          ),
        },
      ])
      root.render(<RouterProvider router={router} />)
      if (empty) {
        await vi.waitFor(() =>
          expect(host.textContent).toContain(
            bindI18n('en').t('projectPicker.emptyTitle'),
          ),
        )
        expect(host.textContent).not.toContain('Available destination')
      } else {
        let option: HTMLButtonElement | undefined
        await vi.waitFor(() => {
          option = [...host.querySelectorAll('button')].find((node) =>
            node.textContent?.includes(project.name),
          )
          expect(option).toBeDefined()
        })
        if (!option) throw new Error('missing retained candidate')
        await act(async () => option!.click())
        expect(selected).toHaveBeenCalledWith(project)
      }
    },
  )
})
