import { waitForBrowserLayout } from '~/test/browser-layout'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { BotSection } from './+components/bot-section'
import '~/app.css'

const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
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
      await expect
        .element(
          dialog.getByText(
            'Select a replacement primary before removing the current primary. Keep at least one destination.',
            { exact: true },
          ),
        )
        .not.toBeInTheDocument()
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
    await expect
      .element(
        dialog.getByText(
          'Select a replacement primary before removing the current primary. Keep at least one destination.',
          { exact: true },
        ),
      )
      .toBeVisible()
    for (const width of [390, 1280]) {
      await page.viewport(width, 800)
      const hint = dialog
        .getByText(
          'Select a replacement primary before removing the current primary. Keep at least one destination.',
          { exact: true },
        )
        .element()
      expect(getComputedStyle(hint).whiteSpace).toBe('normal')
      expect(hint.scrollWidth).toBeLessThanOrEqual(hint.clientWidth)
    }
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

// Browser witness: Radix automatic dismissal and alert geometry cannot be
// established by a service or static-markup test.
test.each([
  ['stop', 'Stop', 'Stop bot', 'en'],
  ['stop', '停止', 'bot を停止', 'ja'],
  ['cancel', 'Cancel creation', 'Cancel creation', 'en'],
  ['cancel', '作成を取り消す', '作成を取り消す', 'ja'],
  ['reissue', 'Reissue token', 'Reissue', 'en'],
] as const)(
  '%s keeps pending and failed confirmation visible on mobile, then retries',
  async (intent, triggerLabel, actionLabel, locale) => {
    language.locale = locale
    await page.viewport(390, 844)
    let finished = false
    const submissions: ((response: Response) => void)[] = []
    const router = createMemoryRouter(
      [
        {
          path: '/settings/bots',
          loader: () => ({
            bots: [
              ...(finished && intent === 'cancel'
                ? []
                : [
                    {
                      ...bot,
                      botStoppedAt:
                        finished && intent === 'stop' ? '2026-01-01' : null,
                      cancelable: true,
                    },
                  ]),
              { ...bot, id: 'other', name: 'Other bot', cancelable: true },
            ],
          }),
          Component: () => (
            <BotSection bots={useLoaderData().bots} canCreate={false} />
          ),
          action: async ({ request }) => {
            expect(await request.json()).toEqual({ intent, botUserId: bot.id })
            return new Promise<Response>((resolve) => submissions.push(resolve))
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
      const trigger = page
        .getByRole('button', { name: triggerLabel, exact: true })
        .first()
      const status = container.querySelector(
        '[data-bot-result], [role="status"]',
      )!
      expect(status.textContent).toBe('')
      const observations: {
        text: string | null
        hidden: boolean
        dialog: boolean
      }[] = []
      const observer = new MutationObserver(() =>
        observations.push({
          text: status.textContent,
          hidden: Boolean(status.closest('[aria-hidden="true"],[inert]')),
          dialog: Boolean(document.querySelector('[role="alertdialog"]')),
        }),
      )
      observer.observe(status, {
        subtree: true,
        characterData: true,
        childList: true,
      })
      const dialog = page.getByRole('alertdialog')
      await trigger.click()
      await expect.element(dialog).toBeVisible()
      await vi.waitFor(() =>
        expect(dialog.element().contains(document.activeElement)).toBe(true),
      )
      await userEvent.keyboard('{Escape}')
      await expect.element(dialog).not.toBeInTheDocument()
      await expect.element(trigger).toHaveFocus()
      await trigger.click()
      await expect.element(dialog).toBeVisible()
      const confirm = dialog.getByRole('button', {
        name: actionLabel,
        exact: true,
      })
      if (intent !== 'reissue')
        expect(confirm.element().className).toContain('bg-destructive')
      if (intent === 'cancel')
        await expect
          .element(
            dialog.getByRole('button', {
              name: bindI18n(locale).t('team.bots.keep'),
              exact: true,
            }),
          )
          .toBeVisible()
      await confirm.click()
      const busyAction = dialog.getByRole('button', {
        name: bindI18n(locale).t(`team.bots.${intent}Confirm.pending`),
        exact: true,
      })
      await expect.element(busyAction).toBeDisabled()
      await expect.element(busyAction).toHaveAttribute('aria-busy', 'true')
      // Capture readiness must identify the action, not both disabled buttons.
      expect(
        dialog
          .element()
          .querySelectorAll('[data-slot="alert-dialog-action"]:disabled'),
      ).toHaveLength(1)
      await expect.element(dialog).toBeVisible()
      await vi.waitFor(() => expect(submissions).toHaveLength(1))
      const disabledConfirm = busyAction.element()
      if (!(disabledConfirm instanceof HTMLButtonElement))
        throw new Error('Expected confirmation button')
      disabledConfirm.click()
      expect(submissions).toHaveLength(1)
      expect(status.textContent).toBe('')
      const scroll = window.scrollY
      await act(async () =>
        submissions[0](Response.json({ error: { code: 'forbidden' } })),
      )
      const alert = dialog.getByRole('alert')
      await expect.element(alert).toBeVisible()
      await waitForBrowserLayout()
      const bounds = alert.element().getBoundingClientRect()
      expect(bounds.top).toBeGreaterThanOrEqual(0)
      expect(bounds.bottom).toBeLessThanOrEqual(844)
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(390)
      expect(window.scrollY).toBe(scroll)
      await confirm.click()
      await expect.element(busyAction).toBeDisabled()
      // Capture readiness must identify the action, not both disabled buttons.
      expect(
        dialog
          .element()
          .querySelectorAll('[data-slot="alert-dialog-action"]:disabled'),
      ).toHaveLength(1)
      await expect.element(dialog.getByRole('alert')).not.toBeInTheDocument()
      await vi.waitFor(() => expect(submissions).toHaveLength(2))
      finished = true
      await act(async () =>
        submissions[1](
          Response.json({
            ok: true,
            ...(intent === 'reissue'
              ? { token: 'synthetic-reissued-token' }
              : {}),
          }),
        ),
      )
      await expect.element(dialog).not.toBeInTheDocument()
      if (intent !== 'reissue') {
        const text =
          locale === 'ja'
            ? intent === 'stop'
              ? '「Reporting bot」を停止しました。'
              : '「Reporting bot」の作成を取り消しました。'
            : intent === 'stop'
              ? 'Stopped Reporting bot.'
              : 'Canceled creation of Reporting bot.'
        await expect.element(page.getByRole('status')).toHaveTextContent(text)
        expect(status.isConnected).toBe(true)
        expect(observations).toEqual([{ text, hidden: false, dialog: false }])
        expect(document.activeElement?.id).toBe(
          intent === 'stop' ? 'bot-row-reports' : 'bots-heading',
        )
      }
      observer.disconnect()
      if (intent === 'stop') {
        await page
          .getByRole('button', {
            name: bindI18n(locale).t('team.bots.reissue'),
            exact: true,
          })
          .click()
        await expect.element(dialog).toBeVisible()
        expect(status.textContent).toBe('')
        await userEvent.keyboard('{Escape}')
        await expect.element(dialog).not.toBeInTheDocument()
      }
      if (intent === 'reissue') {
        await expect
          .element(page.getByTestId('bot-token'))
          .toHaveTextContent('synthetic-reissued-token')
        expect(
          document.querySelectorAll('[data-testid="bot-token"]'),
        ).toHaveLength(1)
        const command = page
          .getByRole('dialog')
          .element()
          .querySelector('p code')
        expect(command).not.toBeNull()
        expect(command?.textContent).toBe(
          `printf '%s' "$TOKEN" | artifactshare profiles import-token --profile bot`,
        )
        if (!command) throw new Error('Missing token import command')
        expect(getComputedStyle(command).whiteSpace).toBe('normal')
        expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth)
        for (const paragraph of page
          .getByRole('dialog')
          .element()
          .querySelectorAll('p')) {
          expect(getComputedStyle(paragraph).textOverflow).not.toBe('ellipsis')
        }
        const tokenDialog = page.getByRole('dialog')
        const token = page.getByTestId('bot-token')
        const panel = tokenDialog.element()
        const close = tokenDialog.getByRole('button', {
          name: 'Close',
          exact: true,
        })
        const checkbox = tokenDialog.getByRole('checkbox')
        await waitForBrowserLayout()
        await Promise.all(
          panel.getAnimations().map((animation) => animation.finished),
        )
        expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
        expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(844)
        await page.viewport(844, 390)
        await waitForBrowserLayout()
        await vi.waitFor(() => {
          const rect = panel.getBoundingClientRect()
          expect(rect.top).toBeGreaterThanOrEqual(0)
          expect(rect.bottom).toBeLessThanOrEqual(390)
        })
        const panelBounds = panel.getBoundingClientRect()
        expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight)
        for (const text of [
          'Bot token',
          bindI18n('en').t('team.bots.token.body'),
        ]) {
          const rect = tokenDialog
            .getByText(text, { exact: true })
            .element()
            .getBoundingClientRect()
          expect(rect.top).toBeGreaterThanOrEqual(panelBounds.top)
          expect(rect.bottom).toBeLessThanOrEqual(panelBounds.bottom)
        }
        expect(panel.querySelector('[data-slot="dialog-close"]')).toBeNull()
        await expect.element(close).toBeDisabled()
        await userEvent.keyboard('{Escape}')
        await waitForBrowserLayout()
        await expect.element(token).toBeVisible()
        await expect.element(tokenDialog).toBeVisible()
        const overlay = document.querySelector('[data-slot="dialog-overlay"]')!
        await userEvent.click(overlay, { position: { x: 5, y: 5 } })
        await waitForBrowserLayout()
        await expect.element(token).toBeVisible()
        await expect.element(tokenDialog).toBeVisible()
        panel.scrollTop = panel.scrollHeight
        await waitForBrowserLayout()
        for (const element of [command, checkbox.element(), close.element()]) {
          const rect = element.getBoundingClientRect()
          expect(rect.top).toBeGreaterThanOrEqual(panelBounds.top)
          expect(rect.bottom).toBeLessThanOrEqual(panelBounds.bottom)
        }
        await checkbox.click()
        const footerClose = page.elementLocator(
          panel.querySelector('[data-slot="dialog-footer"] button')!,
        )
        await expect.element(footerClose).toBeEnabled()
        await footerClose.click()
        await expect.element(tokenDialog).not.toBeInTheDocument()
        await expect.element(token).not.toBeInTheDocument()
      }
      await page
        .getByRole('button', { name: triggerLabel, exact: true })
        .last()
        .click()
      await expect.element(page.getByRole('alertdialog')).toBeVisible()
      await expect
        .element(page.getByRole('alertdialog').getByRole('alert'))
        .not.toBeInTheDocument()
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
      language.locale = 'en'
      await page.viewport(1280, 800)
    }
  },
)

test.each(['en', 'ja'] as const)(
  'preferred project needs Add destination before creation (%s)',
  async (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    const preferred = {
      id: 'reports',
      name: 'Reports',
      baseVisibility: 'private',
      updatedAt: '2026-01-01',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        projects: [preferred],
        preferredProject: preferred,
        nextCursor: null,
      }),
    )
    const router = createMemoryRouter([
      { path: '/', element: <BotSection bots={[]} canCreate /> },
    ])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await page
        .getByRole('button', { name: t('team.bots.add'), exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await expect
        .element(dialog.getByRole('button', { name: /Reports/ }))
        .toHaveAttribute('aria-pressed', 'true')
      await dialog
        .getByRole('textbox', { name: t('team.bots.add.nameLabel') })
        .fill('Weekly reports')
      await expect
        .element(dialog.getByText(t('team.bots.emptyDestinations')))
        .toBeVisible()
      const create = dialog.getByRole('button', {
        name: t('team.bots.add.submit'),
        exact: true,
      })
      await expect.element(create).toBeDisabled()
      const reason = create.element().previousElementSibling!
      await expect.element(page.elementLocator(reason)).toBeVisible()
      expect(reason.textContent).toBe(
        locale === 'en'
          ? 'Choose a project and click “Add destination” to set the primary destination.'
          : 'プロジェクトを選び、「投稿先を追加」を押して既定の投稿先を設定してください。',
      )
      await dialog
        .getByRole('button', {
          name: t('team.bots.addDestination'),
          exact: true,
        })
        .click()
      await expect
        .element(dialog.getByRole('radio', { name: /Reports/ }))
        .toBeChecked()
      await expect.element(create).toBeEnabled()
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
      language.locale = 'en'
    }
  },
)

test('stop returns focus to the Bots heading when revalidation removes the row', async () => {
  let bots = [bot]
  const router = createMemoryRouter(
    [
      {
        path: '/settings/bots',
        loader: () => bots,
        Component: () => (
          <BotSection bots={useLoaderData<typeof bots>()} canCreate={false} />
        ),
        action: () => {
          bots = []
          return { ok: true }
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
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Stop bot', exact: true })
      .click()
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('bot-row')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('heading', { name: 'Bots', exact: true }))
      .toHaveFocus()
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})
