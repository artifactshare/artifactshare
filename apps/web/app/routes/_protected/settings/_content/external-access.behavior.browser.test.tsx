import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  redirect,
  RouterProvider,
  useLoaderData,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import type { WorkspaceLinkPolicy } from '~/lib/link-sharing-policy'
import ExternalAccessPage, { screen } from './external-access'
import '~/app.css'

vi.mock('~/services/link-sharing.server', () => ({}))
vi.mock('~/services/db.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

function Page() {
  const policy = useLoaderData<WorkspaceLinkPolicy>()
  return <ExternalAccessPage loaderData={{ policy }} />
}

// These tests exercise native form submission/validation and Radix confirmation.
test('dirty toggles are discarded on navigation, retained on failure, and saved together on success', async () => {
  let policy: WorkspaceLinkPolicy = {
    plan: 'team',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  }
  const submissions: FormData[] = []
  const router = createMemoryRouter(
    [
      {
        element: (
          <Outlet
            context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
          />
        ),
        children: [
          {
            path: '/settings/external-access',
            Component: Page,
            loader: () => policy,
            action: async ({ request }) => {
              const form = await request.formData()
              submissions.push(form)
              if (submissions.length === 1) return { kind: 'forbidden' }
              policy = {
                ...policy,
                linkSharingEnabled: form
                  .getAll('linkSharingEnabled')
                  .includes('true'),
                externalPostingEnabled: form
                  .getAll('externalPostingEnabled')
                  .includes('true'),
                linkExpiryDefaultDays: Number(form.get('defaultDays')),
              }
              return redirect('/settings/external-access?status=ok')
            },
          },
          { path: '/away', element: <p>Away</p> },
        ],
      },
    ],
    { initialEntries: ['/settings/external-access'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const toggle = page.getByRole('checkbox', { name: /^Link sharing/ })
    await expect.element(toggle).toBeChecked()
    await expect
      .element(
        page.getByText('All changes on this page require Save changes.', {
          exact: false,
        }),
      )
      .toBeVisible()
    await toggle.click()
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    await act(async () => {
      await router.navigate('/away')
    })
    await expect.element(page.getByText('Away', { exact: true })).toBeVisible()
    await act(async () => {
      await router.navigate('/settings/external-access')
    })
    await expect.element(toggle).toBeChecked()
    await toggle.click()
    await page.getByRole('checkbox', { name: /^External posting/ }).click()
    await page
      .getByRole('spinbutton', { name: 'Default expiration', exact: true })
      .fill('7')
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await expect.element(page.getByRole('alert')).toBeVisible()
    await expect.element(toggle).not.toBeChecked()
    await expect
      .element(
        page.getByRole('spinbutton', {
          name: 'Default expiration',
          exact: true,
        }),
      )
      .toHaveValue(7)
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await vi.waitFor(() =>
      expect(router.state.location.search).toBe('?status=ok'),
    )
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0),
    )
    expect(policy).toMatchObject({
      linkSharingEnabled: false,
      externalPostingEnabled: false,
      linkExpiryDefaultDays: 7,
    })
    expect(submissions).toHaveLength(2)
    expect(submissions.map((form) => form.get('intent'))).toEqual([
      'update-external-access',
      'update-external-access',
    ])
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

test.each([
  [90, 1, 30],
  [null, 0, 30],
  [90, 2, 120],
] as const)(
  'maximum %s previews count %s, preserves dismissed edits and confirms the exact draft once',
  async (maximum, count, proposed) => {
    let policy: WorkspaceLinkPolicy = {
      plan: 'team',
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: maximum,
    }
    const submissions: FormData[] = []
    let saveAttempts = 0
    let previewAttempts = 0
    const router = createMemoryRouter(
      [
        {
          element: (
            <Outlet
              context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
            />
          ),
          children: [
            {
              path: '/settings/external-access',
              Component: Page,
              loader: () => policy,
              action: async ({ request }) => {
                const form = await request.formData()
                submissions.push(form)
                if (saveAttempts >= 2) return { kind: 'forbidden' }
                if (proposed === 120)
                  policy = { ...policy, linkExpiryMaxDays: 180 }
                if (
                  form.get('intent') === 'preview-external-access' ||
                  !form.has('confirmedMaximum')
                ) {
                  if (++previewAttempts === 2) return { kind: 'forbidden' }
                  return {
                    kind: 'preview',
                    previousMaximumDays: proposed === 120 ? 180 : maximum,
                    maximumDays: Number(form.get('maxDays')),
                    shortenedLinkCount: count,
                  }
                }
                if (++saveAttempts === 1) return { kind: 'forbidden' }
                policy = {
                  ...policy,
                  linkExpiryMaxDays: Number(form.get('maxDays')),
                  linkSharingEnabled: false,
                }
                return redirect('/settings/external-access?status=ok')
              },
            },
          ],
        },
      ],
      { initialEntries: ['/settings/external-access'] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await page.getByRole('checkbox', { name: /^Link sharing/ }).click()
      if (maximum === null)
        await page
          .getByRole('checkbox', { name: 'No limit', exact: true })
          .click()
      const maxInput = page.getByRole('spinbutton', {
        name: 'Maximum expiration',
        exact: true,
      })
      await maxInput.fill(String(proposed))
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      const dialog = page.getByRole('alertdialog')
      await expect
        .element(dialog)
        .toMatchTextContent(
          new RegExp(
            count === 0
              ? 'No existing links are affected right now'
              : `${count} existing link${count === 1 ? '' : 's'} will be shortened to ${proposed} days`,
          ),
        )
      expect(submissions.map((form) => form.get('intent'))).toEqual([
        proposed === 120 ? 'update-external-access' : 'preview-external-access',
      ])
      const confirm = dialog.getByRole('button', {
        name: 'Save changes',
        exact: true,
      })
      expect(confirm.element().className.includes('bg-destructive')).toBe(
        count > 0,
      )
      // Observe the native exit animation, before Radix removes the content.
      const content = dialog.element()
      const originalText = content.textContent
      const closingText: (string | null)[] = []
      const observer = new MutationObserver(() => {
        if (content.getAttribute('data-state') === 'closed')
          closingText.push(content.textContent)
      })
      observer.observe(content, {
        attributes: true,
        childList: true,
        subtree: true,
      })
      try {
        await dialog
          .getByRole('button', { name: 'Keep editing', exact: true })
          .click()
        await expect.element(dialog).not.toBeInTheDocument()
        expect(closingText.length).toBeGreaterThan(0)
        expect(closingText.every((text) => text === originalText)).toBe(true)
      } finally {
        observer.disconnect()
      }
      await expect.element(maxInput).toHaveValue(proposed)
      await maxInput.fill(String(proposed + 10))
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      await expect.element(page.getByRole('alert')).toBeVisible()
      await expect.element(dialog).not.toBeInTheDocument()
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      await expect
        .element(dialog)
        .toMatchTextContent(new RegExp(`${proposed + 10} days`))
      await confirm.click()
      await expect.element(dialog.getByRole('alert')).toBeVisible()
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      await confirm.click()
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions.map((form) => form.get('intent'))).toEqual([
        proposed === 120 ? 'update-external-access' : 'preview-external-access',
        'preview-external-access',
        'preview-external-access',
        'update-external-access',
        'update-external-access',
      ])
      expect(submissions[3].get('maxDays')).toBe(String(proposed + 10))
      expect(submissions[3].get('confirmedMaximum')).toBe(String(proposed + 10))
      expect(submissions[3].get('confirmedPreviousMaximum')).toBe(
        String(proposed === 120 ? 180 : maximum),
      )
      expect(submissions[3].getAll('linkSharingEnabled')).toEqual(['false'])
      expect(policy.linkExpiryMaxDays).toBe(proposed + 10)
      await maxInput.fill('30')
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      await expect.element(page.getByRole('alert')).toBeVisible()
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions.at(-1)?.get('intent')).toBe('preview-external-access')
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

test('invalid or refused preview cannot save and a later non-reduction bypasses confirmation', async () => {
  const policy: WorkspaceLinkPolicy = {
    plan: 'team',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  }
  const submissions: string[] = []
  const router = createMemoryRouter(
    [
      {
        element: (
          <Outlet
            context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
          />
        ),
        children: [
          {
            path: '/settings/external-access',
            Component: Page,
            loader: () => policy,
            action: async ({ request }) => {
              const form = await request.formData()
              submissions.push(String(form.get('intent')))
              return { kind: 'forbidden' }
            },
          },
        ],
      },
    ],
    { initialEntries: ['/settings/external-access'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const maxInput = page.getByRole('spinbutton', {
      name: 'Maximum expiration',
      exact: true,
    })
    const save = page.getByRole('button', { name: 'Save changes', exact: true })
    await maxInput.fill('0')
    await save.click()
    expect(submissions).toEqual([])
    await maxInput.fill('30')
    await save.click()
    await expect.element(page.getByRole('alert')).toBeVisible()
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument()
    expect(submissions).toEqual(['preview-external-access'])
    await maxInput.fill('120')
    await save.click()
    await vi.waitFor(() =>
      expect(submissions).toEqual([
        'preview-external-access',
        'update-external-access',
      ]),
    )
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument()
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

// The redirect retains fetcher data when loader values do not change. Exercise
// the real router and form so a remount cannot conceal the stale result.
test('successful recovery with unchanged persisted values clears the previous save error', async () => {
  const policy: WorkspaceLinkPolicy = {
    plan: 'team',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  }
  const submissions: FormData[] = []
  const router = createMemoryRouter(
    [
      {
        element: (
          <Outlet
            context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
          />
        ),
        children: [
          {
            path: '/settings/external-access',
            Component: Page,
            loader: () => policy,
            action: async ({ request }) => {
              const form = await request.formData()
              submissions.push(form)
              if (Number(form.get('defaultDays')) > policy.linkExpiryMaxDays!)
                return { kind: 'invalid-policy' }
              return redirect('/settings/external-access?status=ok')
            },
          },
        ],
      },
    ],
    { initialEntries: ['/settings/external-access'] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const defaultDays = page.getByRole('spinbutton', {
      name: 'Default expiration',
      exact: true,
    })
    const save = page.getByRole('button', { name: 'Save changes', exact: true })
    await defaultDays.fill('100')
    await save.click()
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent(bindI18n('en').t('team.status.invalidPolicy'))
    await defaultDays.fill('30')
    await save.click()
    await vi.waitFor(() =>
      expect(router.state.location.search).toBe('?status=ok'),
    )
    await expect.element(save).toBeEnabled()
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
    await expect.element(defaultDays).toHaveValue(30)
    expect(submissions.map((form) => form.get('defaultDays'))).toEqual([
      '100',
      '30',
    ])
    // A new failure with the same kind must still be shown after recovery.
    await defaultDays.fill('100')
    await save.click()
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent(bindI18n('en').t('team.status.invalidPolicy'))
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

// Hydrated native action data must join the real form/Radix lifecycle.
test.each(['preview', 'forbidden'] as const)(
  'native %s retains the draft and starts a fresh confirmation',
  async (kind) => {
    const policy: WorkspaceLinkPolicy = {
      plan: 'team',
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 90,
    }
    const draft = {
      defaultDays: '7',
      maxDays: '30',
      defaultUnlimited: false,
      maxUnlimited: false,
      linkSharingEnabled: false,
      externalPostingEnabled: false,
    }
    const previewResult = {
      kind: 'preview',
      previousMaximumDays: 90,
      maximumDays: 30,
      shortenedLinkCount: 2,
      draft,
      resume: 'linkSharing',
    }
    const submissions: FormData[] = []
    const router = createMemoryRouter(
      [
        {
          element: (
            <Outlet
              context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
            />
          ),
          children: [
            {
              id: 'settings',
              path: '/settings/external-access',
              element: <ExternalAccessPage loaderData={{ policy }} />,
              action: async ({ request }) => {
                const form = await request.formData()
                submissions.push(form)
                if (form.get('intent') === 'preview-external-access')
                  return previewResult
                return redirect('/settings/external-access?status=ok')
              },
            },
          ],
        },
      ],
      {
        initialEntries: ['/settings/external-access'],
        hydrationData: {
          actionData: {
            settings: kind === 'preview' ? previewResult : { kind, draft },
          },
        },
      },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      const dialog = page.getByRole('alertdialog')
      if (kind === 'forbidden') {
        await expect.element(page.getByRole('alert')).toBeVisible()
        await page
          .getByRole('button', { name: 'Save changes', exact: true })
          .click()
      }
      await expect
        .element(dialog)
        .toMatchTextContent(/2 existing links will be shortened to 30 days/)
      await expect.element(dialog.getByRole('alert')).not.toBeInTheDocument()
      await dialog
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      await vi.waitFor(() =>
        expect(router.state.location.search).toBe('?status=ok'),
      )
      await expect.element(dialog).not.toBeInTheDocument()
      const saved = submissions.at(-1)
      expect(saved?.get('intent')).toBe('update-external-access')
      expect(saved?.get('defaultDays')).toBe('7')
      expect(saved?.get('maxDays')).toBe('30')
      expect(saved?.getAll('linkSharingEnabled')).toEqual(['false'])
      expect(saved?.getAll('externalPostingEnabled')).toEqual(['false'])
      expect(saved?.get('confirmedPreviousMaximum')).toBe('90')
      expect(saved?.get('confirmedMaximum')).toBe('30')
      if (kind === 'preview') expect(saved?.get('resume')).toBe('linkSharing')
      expect(submissions).toHaveLength(kind === 'preview' ? 1 : 2)
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

// The real router and Radix exit animation expose duplicate alerts during dismissal.
test.each([30, 90])(
  'server maximum %s controls confirmation and failed-save dismissal has one alert',
  async (storedMaximum) => {
    const policy: WorkspaceLinkPolicy = {
      plan: 'team',
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 90,
    }
    const submissions: string[] = []
    const disabledDuringHandoff: boolean[] = []
    const router = createMemoryRouter(
      [
        {
          element: (
            <Outlet
              context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
            />
          ),
          children: [
            {
              path: '/settings/external-access',
              Component: Page,
              loader: () => policy,
              action: async ({ request }) => {
                const form = await request.formData()
                const intent = String(form.get('intent'))
                submissions.push(intent)
                return intent === 'preview-external-access'
                  ? {
                      kind: 'preview',
                      previousMaximumDays: storedMaximum,
                      maximumDays: 60,
                      shortenedLinkCount: 0,
                    }
                  : { kind: 'forbidden' }
              },
            },
          ],
        },
      ],
      { initialEntries: ['/settings/external-access'] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <Profiler
            id="external-access"
            onRender={() => {
              // Observe every committed frame, including the one before the
              // effect starts saving a preview that is no longer a reduction.
              if (
                storedMaximum === 30 &&
                submissions.length > 0 &&
                !container.querySelector('[role="alert"]')
              ) {
                const maximum = container.querySelector<HTMLInputElement>(
                  'input[name="maxDays"]',
                )
                if (!maximum) throw new Error('Maximum expiration is missing')
                disabledDuringHandoff.push(maximum.disabled)
              }
            }}
          >
            <RouterProvider router={router} />
          </Profiler>,
        ),
      )
      await page
        .getByRole('spinbutton', { name: 'Maximum expiration', exact: true })
        .fill('60')
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      const dialog = page.getByRole('alertdialog')
      if (storedMaximum === 90) {
        await expect.element(dialog).toBeVisible()
        expect(submissions).toEqual(['preview-external-access'])
        await dialog
          .getByRole('button', { name: 'Save changes', exact: true })
          .click()
        await expect.element(dialog.getByRole('alert')).toBeVisible()
        const closingAlertCounts: number[] = []
        const content = dialog.element()
        const observer = new MutationObserver(() => {
          if (content.getAttribute('data-state') === 'closed')
            closingAlertCounts.push(
              document.querySelectorAll('[role="alert"]').length,
            )
        })
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
        })
        try {
          await dialog
            .getByRole('button', { name: 'Keep editing', exact: true })
            .click()
          await expect.element(dialog).not.toBeInTheDocument()
          expect(closingAlertCounts.length).toBeGreaterThan(0)
          expect(closingAlertCounts.every((count) => count === 1)).toBe(true)
        } finally {
          observer.disconnect()
        }
      }
      await expect.element(page.getByRole('alert')).toBeVisible()
      if (storedMaximum === 30) {
        expect(disabledDuringHandoff.length).toBeGreaterThan(0)
        expect(disabledDuringHandoff.every(Boolean)).toBe(true)
      }
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions).toEqual([
        'preview-external-access',
        'update-external-access',
      ])
      await expect
        .element(
          page.getByRole('spinbutton', {
            name: 'Maximum expiration',
            exact: true,
          }),
        )
        .toHaveValue(60)
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

// Radix's hidden input must preserve the native FormData contract, while the
// visible control supports label and keyboard activation in the real form.
test('product checkboxes preserve checked, unchecked, disabled and coupled expiry values', async () => {
  const policy: WorkspaceLinkPolicy = {
    plan: 'team',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: null,
  }
  const router = createMemoryRouter([
    {
      element: (
        <Outlet
          context={{ currentUserIsAdmin: true, currentUserRole: 'owner' }}
        />
      ),
      children: [
        { path: '/', element: <ExternalAccessPage loaderData={{ policy }} /> },
      ],
    },
  ])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const maximum = page.getByRole('checkbox', {
      name: 'No limit',
      exact: true,
    })
    const defaultUnlimited = page.getByRole('checkbox', {
      name: 'No expiration',
      exact: true,
    })
    // Exercise the actual ledger selectors: Radix assigns name to its hidden
    // input, not to the visible button used by capture interactions.
    const selectors = new Set(
      screen.states.flatMap((state) =>
        'interactions' in state.setup
          ? (state.setup.interactions ?? [])
              .map((step) => step.selector)
              .filter((selector) => selector.includes('data-policy-control'))
          : [],
      ),
    )
    expect(selectors.size).toBe(3)
    for (const selector of selectors) {
      const target = container.querySelector(selector)
      expect(target?.getAttribute('role')).toBe('checkbox')
      expect(target?.checkVisibility()).toBe(true)
    }
    await expect.element(maximum).toBeChecked()
    const form = maximum.element().closest('form')!
    const values = () => new FormData(form)
    expect(values().get('maxUnlimited')).toBe('true')
    expect(values().has('maxDays')).toBe(false)
    await defaultUnlimited.click()
    await expect.element(defaultUnlimited).toBeChecked()
    expect(values().get('defaultUnlimited')).toBe('true')
    expect(values().has('defaultDays')).toBe(false)
    await maximum.click()
    await expect.element(maximum).not.toBeChecked()
    await expect.element(defaultUnlimited).not.toBeInTheDocument()
    expect(values().has('maxUnlimited')).toBe(false)
    expect(values().has('defaultUnlimited')).toBe(false)
    expect(values().get('defaultDays')).toBe('30')
    const sharing = page.getByRole('checkbox', { name: /^Link sharing/ })
    expect(values().getAll('linkSharingEnabled')).toEqual(['false', 'true'])
    const label = sharing.element().closest('label')!
    await page
      .getByText(label.querySelector('strong')!.textContent!, { exact: true })
      .click()
    await expect.element(sharing).not.toBeChecked()
    expect(values().getAll('linkSharingEnabled')).toEqual(['false'])
    await sharing.click()
    await expect.element(sharing).toBeChecked()
    await userEvent.keyboard(' ')
    await expect.element(sharing).not.toBeChecked()
    expect(values().getAll('linkSharingEnabled')).toEqual(['false'])
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

test('permission-disabled product checkboxes retain their state and submit no values', async () => {
  const policy: WorkspaceLinkPolicy = {
    plan: 'team',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: null,
    linkExpiryMaxDays: null,
  }
  const router = createMemoryRouter([
    {
      element: (
        <Outlet
          context={{ currentUserIsAdmin: false, currentUserRole: 'member' }}
        />
      ),
      children: [
        { path: '/', element: <ExternalAccessPage loaderData={{ policy }} /> },
      ],
    },
  ])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const controls = container.querySelectorAll<HTMLButtonElement>(
      '[data-slot="checkbox"]',
    )
    expect(controls).toHaveLength(4)
    const values = new FormData(controls[0].closest('form')!)
    for (const control of controls) {
      expect(control.disabled).toBe(true)
      expect(control.getAttribute('aria-checked')).toBe('true')
      expect(values.has(control.dataset.policyControl!)).toBe(false)
    }
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})
