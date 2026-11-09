import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { BotSection } from './+components/bot-section'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
afterEach(() => vi.restoreAllMocks())

const bot = {
  id: 'reports',
  name: 'Reporting bot',
  email: 'reports@bots.artifactshare.invalid',
  botStoppedAt: null,
  projectId: 'a',
  projectName: 'Reports',
  projectNameSnapshot: 'Reports',
  credentialLive: true,
  lastAuthAt: null,
  cancelable: false,
  destinationRevision: 'revision',
  approvedProjects: [
    { id: 'a', name: 'Reports', unavailable: false },
    { id: 'b', name: 'Management', unavailable: false },
  ],
}

test('requires explicit primary replacement, preserves failed input and prevents duplicate saves', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ projects: [], preferredProject: null, nextCursor: null }),
  )
  await page.viewport(390, 400)
  const saved: unknown[] = []
  let release: ((value: Response) => void) | undefined
  const router = createMemoryRouter(
    [
      {
        path: '/settings/bots',
        element: (
          <BotSection
            bots={[
              {
                ...bot,
                approvedProjects: [
                  ...bot.approvedProjects,
                  { id: 'c', name: 'Archived', unavailable: true },
                ],
              },
            ]}
            canCreate={false}
          />
        ),
        action: async ({ request }) => {
          saved.push(await request.json())
          if (saved.length === 1)
            return Response.json(
              { error: { code: 'bot-destination-invalid' } },
              { status: 400 },
            )
          return new Promise<Response>((resolve) => {
            release = resolve
          })
        },
      },
    ],
    { initialEntries: ['/settings/bots'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const tableContainer = container.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    )!
    expect(tableContainer.scrollWidth).toBeLessThanOrEqual(
      tableContainer.clientWidth,
    )
    const edit = page.getByRole('button', {
      name: 'Edit destinations',
      exact: true,
    })
    const bounds = edit.element().getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(390)
    await expect
      .element(page.getByText('Last credential refresh:', { exact: true }))
      .toBeVisible()
    await edit.click()
    const dialog = page.getByRole('dialog')
    await expect.element(dialog).toBeVisible()
    expect(dialog.element().getBoundingClientRect().height).toBeLessThanOrEqual(
      400,
    )
    expect(container.scrollWidth).toBeLessThanOrEqual(390)
    await expect
      .element(
        dialog.getByRole('radio', {
          name: 'Archived · Unavailable',
          exact: true,
        }),
      )
      .toBeDisabled()
    await dialog
      .getByRole('button', { name: 'Remove Archived', exact: true })
      .click()
    await expect
      .element(
        dialog.getByRole('button', { name: 'Remove Reports', exact: true }),
      )
      .toBeDisabled()
    await dialog.getByRole('radio', { name: 'Management', exact: true }).click()
    await dialog
      .getByRole('button', { name: 'Remove Reports', exact: true })
      .click()
    await expect
      .element(
        dialog.getByRole('button', { name: 'Remove Management', exact: true }),
      )
      .toBeDisabled()
    const save = dialog.getByRole('button', {
      name: 'Save destinations',
      exact: true,
    })
    await save.click()
    await expect.element(dialog.getByRole('alert')).toBeVisible()
    await expect
      .element(
        dialog.getByRole('radio', {
          name: 'Management (Primary)',
          exact: true,
        }),
      )
      .toBeChecked()
    await save.click()
    await expect.element(save).toBeDisabled()
    expect(saved).toEqual(
      [1, 2].map(() => ({
        intent: 'destinations',
        botUserId: 'reports',
        projectId: 'b',
        projectIds: ['b'],
        revision: 'revision',
      })),
    )
    await act(async () => release!(Response.json({ ok: true })))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect
      .element(
        page.getByRole('button', { name: 'Edit destinations', exact: true }),
      )
      .toHaveFocus()
    await page
      .getByRole('button', { name: 'Edit destinations', exact: true })
      .click()
    await expect
      .element(
        page.getByRole('button', { name: 'Save destinations', exact: true }),
      )
      .toBeEnabled()
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
    await page.viewport(1280, 800)
  }
})

test('creation uses the existing picker and recovers from candidate failure and empty candidates', async () => {
  const candidate = {
    id: 'b',
    name: 'Management',
    baseVisibility: 'private',
    updatedAt: '2026-01-01',
  }
  vi.spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(
      Response.json({ projects: [], preferredProject: null, nextCursor: null }),
    )
    .mockResolvedValue(
      Response.json({
        projects: [candidate],
        preferredProject: candidate,
        nextCursor: null,
      }),
    )
  await page.viewport(390, 400)
  const saved: unknown[] = []
  const router = createMemoryRouter(
    [
      {
        path: '/settings/bots',
        element: <BotSection bots={[]} canCreate />,
        action: async ({ request }) => {
          saved.push(await request.json())
          return Response.json({ token: 'synthetic-test-token' })
        },
      },
    ],
    { initialEntries: ['/settings/bots'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await page.getByRole('button', { name: 'Add bot', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect.element(dialog).toBeVisible()
    expect(dialog.element().getBoundingClientRect().height).toBeLessThanOrEqual(
      400,
    )
    expect(container.scrollWidth).toBeLessThanOrEqual(390)
    await expect.element(dialog.getByRole('alert')).toBeVisible()
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect
      .element(dialog.getByText('No projects yet', { exact: true }))
      .toBeVisible()
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect
      .element(
        dialog.getByText(
          'No destinations added yet. Choose a project and select Add destination.',
          { exact: true },
        ),
      )
      .toBeVisible()
    await expect
      .element(
        dialog.getByRole('group', { name: 'Project to add', exact: true }),
      )
      .toBeVisible()
    await expect
      .element(dialog.getByRole('button', { name: 'Create bot', exact: true }))
      .toBeDisabled()
    for (const width of [390, 1280]) {
      await page.viewport(width, 800)
      const element = dialog.element() as HTMLElement
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth)
      const hint = dialog
        .getByText(
          'Select a replacement primary before removing the current primary. Keep at least one destination.',
          { exact: true },
        )
        .element() as HTMLElement
      expect(getComputedStyle(hint).whiteSpace).toBe('normal')
      expect(hint.scrollWidth).toBeLessThanOrEqual(hint.clientWidth)
      const addBounds = dialog
        .getByRole('button', { name: 'Add destination', exact: true })
        .element()
        .getBoundingClientRect()
      expect(addBounds.right).toBeLessThanOrEqual(
        element.getBoundingClientRect().right,
      )
    }
    await dialog.getByRole('button', { name: /^Management/ }).click()
    await expect
      .element(
        dialog.getByRole('button', { name: 'Add destination', exact: true }),
      )
      .toBeEnabled()
    await dialog
      .getByRole('button', { name: 'Add destination', exact: true })
      .click()
    await expect
      .element(dialog.getByRole('button', { name: /^Management/ }))
      .not.toBeInTheDocument()
    await expect
      .element(
        dialog.getByText('All listed projects have been added.', {
          exact: true,
        }),
      )
      .toBeVisible()
    await dialog
      .getByRole('textbox', { name: 'Bot name', exact: true })
      .fill('Reports')
    await dialog
      .getByRole('button', { name: 'Create bot', exact: true })
      .click()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          intent: 'create',
          name: 'Reports',
          projectId: 'b',
          projectIds: ['b'],
        },
      ]),
    )
    await expect
      .element(page.getByText('synthetic-test-token', { exact: true }))
      .toBeVisible()
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
    await page.viewport(1280, 800)
  }
})

test('conflict reloads inventory so reopening can save the current revision', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ projects: [], preferredProject: null, nextCursor: null }),
  )
  let revision = 'original'
  const saved: { revision: string }[] = []
  const loader = vi.fn(() => [{ ...bot, destinationRevision: revision }])
  function Inventory() {
    const bots = useLoaderData<typeof loader>()
    return <BotSection bots={bots} canCreate={false} />
  }
  const router = createMemoryRouter(
    [
      {
        path: '/settings/bots',
        loader,
        Component: Inventory,
        action: async ({ request }) => {
          const input = (await request.json()) as { revision: string }
          saved.push(input)
          if (saved.length === 1) {
            revision = 'current'
            return Response.json(
              { error: { code: 'bot-conflict' } },
              { status: 409 },
            )
          }
          return Response.json(
            input.revision === revision
              ? { ok: true }
              : { error: { code: 'bot-conflict' } },
            { status: input.revision === revision ? 200 : 409 },
          )
        },
      },
    ],
    { initialEntries: ['/settings/bots'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const edit = page.getByRole('button', {
      name: 'Edit destinations',
      exact: true,
    })
    await edit.click()
    await page.getByRole('radio', { name: 'Management', exact: true }).click()
    await page
      .getByRole('button', { name: 'Save destinations', exact: true })
      .click()
    await expect.element(page.getByRole('alert')).toBeVisible()
    await expect
      .element(
        page.getByRole('radio', { name: 'Management (Primary)', exact: true }),
      )
      .toBeChecked()
    await vi.waitFor(() => expect(loader.mock.calls.length).toBeGreaterThan(1))
    await page
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click()
    await edit.click()
    await page
      .getByRole('button', { name: 'Save destinations', exact: true })
      .click()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(saved.map((input) => input.revision)).toEqual([
      'original',
      'current',
    ])
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
    await page.viewport(1280, 800)
  }
})
