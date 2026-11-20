import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  redirect,
  RouterProvider,
  useLoaderData,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import type { WorkspaceLinkPolicy } from '~/lib/link-sharing-policy'
import ExternalAccessPage from './external-access'
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
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2)
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
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2)
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
  [90, 2],
  [null, 0],
] as const)(
  'maximum %s previews count %s, preserves dismissed edits and confirms the exact draft once',
  async (maximum, count) => {
    let policy: WorkspaceLinkPolicy = {
      plan: 'team',
      linkSharingEnabled: true,
      externalPostingEnabled: true,
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: maximum,
    }
    const submissions: FormData[] = []
    let saveAttempts = 0
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
                if (form.get('intent') === 'preview-external-access')
                  return {
                    kind: 'preview',
                    maximumDays: Number(form.get('maxDays')),
                    shortenedLinkCount: count,
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
      await maxInput.fill('30')
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      const dialog = page.getByRole('alertdialog')
      await expect
        .element(dialog)
        .toMatchTextContent(
          new RegExp(`Existing links to shorten at preview time: ${count}`),
        )
      expect(submissions.map((form) => form.get('intent'))).toEqual([
        'preview-external-access',
      ])
      const confirm = dialog.getByRole('button', {
        name: 'Save changes',
        exact: true,
      })
      expect(confirm.element().className).toContain('bg-destructive')
      await dialog
        .getByRole('button', { name: 'Keep editing', exact: true })
        .click()
      await expect.element(dialog).not.toBeInTheDocument()
      await expect.element(maxInput).toHaveValue(30)
      await maxInput.fill('40')
      await page
        .getByRole('button', { name: 'Save changes', exact: true })
        .click()
      await expect.element(dialog).toMatchTextContent(/40 days/)
      await confirm.click()
      await expect.element(dialog.getByRole('alert')).toBeVisible()
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      await confirm.click()
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions.map((form) => form.get('intent'))).toEqual([
        'preview-external-access',
        'preview-external-access',
        'update-external-access',
        'update-external-access',
      ])
      expect(submissions[2].get('maxDays')).toBe('40')
      expect(submissions[2].getAll('linkSharingEnabled')).toEqual(['false'])
      expect(policy.linkExpiryMaxDays).toBe(40)
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
