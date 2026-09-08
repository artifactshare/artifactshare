// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { addDaysToLocalDate, localDateEndAsUtc } from '~/lib/link-expiry-date'

const revalidate = vi.hoisted(() => vi.fn())
const buildShareableUrl = vi.hoisted(() =>
  vi.fn(() => 'https://abc123def4.artifactshare.link/'),
)
const copyState = vi.hoisted((): { state: 'idle' | 'failed' } => ({
  state: 'idle',
}))

vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string) => key,
  }),
}))
vi.mock('~/hooks/use-copy-state', () => ({
  useCopyState: () => ({ state: copyState.state, copy: vi.fn() }),
}))
vi.mock('~/lib/share-url', () => ({ buildShareableUrl }))
vi.mock('~/components/app/visibility-select', () => ({
  VisibilitySelect: ({
    availableVisibilities,
    disabled,
    onSelect,
  }: {
    availableVisibilities: string[]
    disabled?: boolean
    onSelect: (visibility: string) => void
  }) => (
    <div>
      {availableVisibilities.map((visibility) => (
        <button
          key={visibility}
          type="button"
          data-visibility={visibility}
          disabled={disabled}
          onClick={() => onSelect(visibility)}
        >
          {visibility}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('./visibility-grants-section', () => ({
  VisibilityGrantsSection: ({
    onCommitGrantInput,
    pendingAddEmails,
    pendingRemoves,
  }: {
    onCommitGrantInput: (value: string) => void
    pendingAddEmails: string[]
    pendingRemoves: Set<string>
  }) => (
    <div
      data-grant-state
      data-pending-adds={pendingAddEmails.join(',')}
      data-pending-removes={Array.from(pendingRemoves).join(',')}
    >
      <button
        type="button"
        data-add-grant
        onClick={() => onCommitGrantInput('viewer@example.com')}
      >
        Add grant
      </button>
    </div>
  ),
}))
vi.mock('~/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
  }) =>
    open ? (
      <div>
        <button
          type="button"
          data-dialog-dismiss
          onClick={() => onOpenChange(false)}
        >
          Dismiss
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({
    children,
    showCloseButton,
  }: {
    children: ReactNode
    showCloseButton?: boolean
  }) => (
    <section data-show-close-button={String(showCloseButton !== false)}>
      {children}
    </section>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({
    asChild,
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & {
    asChild?: boolean
    variant?: string
    size?: string
  }) => (asChild ? children : <button {...props}>{children}</button>),
}))
vi.mock('~/components/ui/input', () => ({
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
}))

import { VisibilityDialog } from './visibility-dialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('VisibilityDialog link save flow', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const onOpenChange = vi.fn()
  const fetchMock = vi.fn()

  beforeEach(() => {
    copyState.state = 'idle'
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    onOpenChange.mockReset()
    revalidate.mockReset()
    revalidate.mockResolvedValue(undefined)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url, init: RequestInit) => {
      if (String(url).endsWith('/grants/lookup')) {
        return Response.json({ entries: [] })
      }
      const payload = JSON.parse(String(init.body ?? '{}')) as {
        visibility?: string
        link_expires_at?: string | null
      }
      return saveResponse({
        visibility: payload.visibility ?? 'link',
        link_expires_at: Object.hasOwn(payload, 'link_expires_at')
          ? (payload.link_expires_at ?? null)
          : null,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function renderDialog(
    overrides: Partial<React.ComponentProps<typeof VisibilityDialog>> = {},
  ) {
    return React.act(async () => {
      root.render(
        <VisibilityDialog
          open
          onOpenChange={onOpenChange}
          shareableId="abc123def4"
          currentVisibility="private"
          availableVisibilities={['private', 'link']}
          workspaceHd={null}
          projectBaseVisibility={null}
          owner={{
            id: 'owner-1',
            email: 'owner@example.com',
            name: 'Owner',
            image: null,
            initial: 'O',
          }}
          grants={[]}
          linkSharingAvailable
          linkExpiresAt={null}
          linkExpiryDefaultDays={null}
          linkExpiryMaxDays={null}
          linkExpired={false}
          {...overrides}
        />,
      )
    })
  }

  test('shows only Close while the dialog is unchanged', async () => {
    await renderDialog()

    const footerLabels = Array.from(
      host.querySelectorAll('footer button'),
      (button) => button.textContent,
    )
    expect(footerLabels).toEqual(['visibilityDialog.close'])
  })

  test('shows Cancel and Save while changes are pending', async () => {
    await renderDialog()

    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })

    const footerLabels = Array.from(
      host.querySelectorAll('footer button'),
      (button) => button.textContent,
    )
    expect(footerLabels).toEqual([
      'visibilityDialog.cancel',
      'visibilityDialog.save',
    ])
  })

  test('keeps the dialog open and reveals copy and recipient actions', async () => {
    await renderDialog()

    expect(host.querySelector('a')).toBeNull()
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    const save = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'visibilityDialog.save',
    )
    await React.act(async () => save?.click())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      visibility: 'link',
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(revalidate).toHaveBeenCalledTimes(1)
    const recipientLink = host.querySelector<HTMLAnchorElement>('a')
    expect(recipientLink?.href).toBe('https://abc123def4.artifactshare.link/')
    expect(recipientLink?.target).toBe('_blank')
    expect(recipientLink?.rel).toBe('noopener noreferrer')
    expect(host.textContent).toContain('visibilityDialog.link.copyButton')
    expect(host.textContent).toContain('visibilityDialog.close')
    expect(host.textContent).not.toContain('visibilityDialog.cancel')
  })

  test('shows a failed copy state instead of silently restoring the action label', async () => {
    copyState.state = 'failed'
    await renderDialog({ currentVisibility: 'link' })

    expect(host.textContent).toContain('visibilityDialog.link.copyFailed')
    expect(host.textContent).not.toContain('visibilityDialog.link.copyButton')
  })

  test('returns to Close without posting after an abandoned link expiry edit', async () => {
    await renderDialog({
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })

    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    await changeInput(expiryInput, '2026-10-20')
    await React.act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.click()
    })

    expect(
      Array.from(
        host.querySelectorAll('footer button'),
        (button) => button.textContent,
      ),
    ).toEqual(['visibilityDialog.close'])
    const close = host.querySelector<HTMLButtonElement>('footer button')
    await React.act(async () => close?.click())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('omits a restored expiry from a grant-only save payload', async () => {
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    const originalDate =
      host.querySelector<HTMLInputElement>('input[type="date"]')!.value

    await React.act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.click()
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-add-grant]')?.click()
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    await changeInput(expiryInput, '2026-10-20')
    await changeInput(expiryInput, originalDate)

    const save = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'visibilityDialog.save',
    )
    await React.act(async () => save?.click())

    const saveCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/save'),
    )
    expect(JSON.parse(saveCall?.[1].body)).toEqual({
      addEmails: ['viewer@example.com'],
    })
  })

  test('keeps submitted grant rows until fresh loader grants arrive', async () => {
    const revalidation = deferred<void>()
    revalidate.mockReturnValueOnce(revalidation.promise)
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.click()
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-add-grant]')?.click()
    })
    await clickFooterButton('visibilityDialog.save')

    expect(
      host
        .querySelector('[data-grant-state]')
        ?.getAttribute('data-pending-adds'),
    ).toBe('viewer@example.com')
    const saveCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/save'),
    )
    expect(JSON.parse(saveCall?.[1].body)).toEqual({
      visibility: 'private',
      addEmails: ['viewer@example.com'],
    })

    await renderDialog({
      currentVisibility: 'private',
      grants: [
        {
          email: 'viewer@example.com',
          grantedAt: '2026-09-07T00:00:00.000Z',
          user: null,
        },
      ],
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => revalidation.resolve())
    expect(
      host
        .querySelector('[data-grant-state]')
        ?.getAttribute('data-pending-adds'),
    ).toBe('')
  })

  test('uses the revalidated expiry as the baseline after save', async () => {
    const initialLoaderProps = {
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    } as const
    const revalidation = deferred<void>()
    revalidate.mockReturnValueOnce(revalidation.promise)
    await renderDialog(initialLoaderProps)
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    const originalDate = expiryInput.value
    const nextDate = '2026-10-20'

    await changeInput(expiryInput, nextDate)
    await clickFooterButton('visibilityDialog.save')
    expect(revalidate).toHaveBeenCalledTimes(1)

    await renderDialog({
      ...initialLoaderProps,
      linkExpiresAt: localDateEndAsUtc(nextDate),
    })
    await React.act(async () => revalidation.resolve())
    await renderDialog({
      ...initialLoaderProps,
      open: false,
      linkExpiresAt: localDateEndAsUtc(nextDate),
    })
    await renderDialog({
      ...initialLoaderProps,
      linkExpiresAt: localDateEndAsUtc(nextDate),
    })
    const reopenedExpiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    expect(reopenedExpiryInput.value).toBe(nextDate)

    await changeInput(reopenedExpiryInput, originalDate)
    expect(
      Array.from(
        host.querySelectorAll('footer button'),
        (button) => button.textContent,
      ),
    ).toEqual(['visibilityDialog.cancel', 'visibilityDialog.save'])
    await clickFooterButton('visibilityDialog.save')

    const saveBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/save'))
      .map(([, options]) => JSON.parse(options.body))
    expect(saveBodies).toEqual([
      { link_expires_at: localDateEndAsUtc(nextDate) },
      { link_expires_at: localDateEndAsUtc(originalDate) },
    ])
  })

  test('resets local edits when a different artifact opens in the same dialog', async () => {
    await renderDialog({
      shareableId: 'artifact-a',
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    await changeInput(
      host.querySelector<HTMLInputElement>('input[type="date"]')!,
      '2026-10-20',
    )

    await renderDialog({
      shareableId: 'artifact-b',
      currentVisibility: 'private',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })

    expect(
      host.querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.disabled,
    ).toBe(false)
    expect(host.querySelector('input[type="date"]')).toBeNull()
    expect(
      Array.from(
        host.querySelectorAll('footer button'),
        (button) => button.textContent,
      ),
    ).toEqual(['visibilityDialog.close'])
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(addDaysToLocalDate(30))
  })

  test('keeps unlimited expiry canonical after save and restores the finite default on reopen', async () => {
    const revalidation = deferred<void>()
    revalidate.mockReturnValueOnce(revalidation.promise)
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    const unlimited = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!

    await React.act(async () => unlimited.click())
    await clickFooterButton('visibilityDialog.save')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      link_expires_at: null,
    })

    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => revalidation.resolve())
    await renderDialog({
      open: false,
      currentVisibility: 'link',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })

    const reopenedUnlimited = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!
    expect(reopenedUnlimited.checked).toBe(true)
    await React.act(async () => reopenedUnlimited.click())
    const defaultDate = addDaysToLocalDate(30)
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(defaultDate)
    await clickFooterButton('visibilityDialog.save')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      link_expires_at: localDateEndAsUtc(defaultDate),
    })
  })

  test('does not carry a saved link expiry through a private save and reopen', async () => {
    const expiryRevalidation = deferred<void>()
    const privateRevalidation = deferred<void>()
    revalidate
      .mockReturnValueOnce(expiryRevalidation.promise)
      .mockReturnValueOnce(privateRevalidation.promise)
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    const savedDate = '2026-10-20'
    await changeInput(
      host.querySelector<HTMLInputElement>('input[type="date"]')!,
      savedDate,
    )
    await clickFooterButton('visibilityDialog.save')
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: localDateEndAsUtc(savedDate),
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => expiryRevalidation.resolve())

    await React.act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.click()
    })
    await clickFooterButton('visibilityDialog.save')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      visibility: 'private',
    })
    await renderDialog({
      currentVisibility: 'private',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => privateRevalidation.resolve())
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await renderDialog({
      open: false,
      currentVisibility: 'private',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await renderDialog({
      currentVisibility: 'private',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(addDaysToLocalDate(30))
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).not.toBe(savedDate)
  })

  test('keeps editing locked but allows dismissal and preserves the draft while saving', async () => {
    const post = deferred<Response>()
    const revalidation = deferred<void>()
    const onSavingChange = vi.fn()
    fetchMock.mockReturnValueOnce(post.promise)
    revalidate.mockReturnValueOnce(revalidation.promise)
    const nextDate = '2026-10-20'
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
      onSavingChange,
    })
    const savingStatus = expectSavingStatus(false)
    await changeInput(
      host.querySelector<HTMLInputElement>('input[type="date"]')!,
      nextDate,
    )
    await clickFooterButton('visibilityDialog.save')

    expect(onSavingChange).toHaveBeenCalledWith(true)
    expectSavingControls(true)
    expect(expectSavingStatus(true)).toBe(savingStatus)
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-dialog-dismiss]')?.click()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await renderDialog({
      open: false,
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(nextDate)
    expectSavingControls(true)
    const reopenedSavingStatus = expectSavingStatus(true)

    await React.act(async () =>
      post.resolve(
        saveResponse({
          visibility: 'link',
          link_expires_at: localDateEndAsUtc(nextDate),
        }),
      ),
    )
    expect(revalidate).toHaveBeenCalledTimes(1)
    expectSavingControls(true)
    expect(expectSavingStatus(true)).toBe(reopenedSavingStatus)

    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: localDateEndAsUtc(nextDate),
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => revalidation.resolve())
    expectSavingControls(false)
    expect(expectSavingStatus(false)).toBe(reopenedSavingStatus)
    expect(onSavingChange.mock.calls).toEqual([[true], [false]])
  })

  test('uses the canonical server expiry when the policy default equals its maximum', async () => {
    const revalidation = deferred<void>()
    const canonicalDate = addDaysToLocalDate(30)
    fetchMock.mockResolvedValueOnce(
      saveResponse({
        visibility: 'link',
        link_expires_at: localDateEndAsUtc(canonicalDate),
      }),
    )
    revalidate.mockReturnValueOnce(revalidation.promise)
    await renderDialog({
      currentVisibility: 'private',
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 30,
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    await clickFooterButton('visibilityDialog.save')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      visibility: 'link',
    })
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(canonicalDate)
    expect(
      Array.from(
        host.querySelectorAll('footer button'),
        (button) => button.textContent,
      ),
    ).toEqual(['visibilityDialog.close'])
    expectSavingControls(true)

    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: localDateEndAsUtc(canonicalDate),
      linkExpiryDefaultDays: 30,
      linkExpiryMaxDays: 30,
    })
    await React.act(async () => revalidation.resolve())
    expectSavingControls(false)
  })

  test('does not manufacture an expiry override when midnight changes the default', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 19, 23, 58))
    await renderDialog({
      currentVisibility: 'private',
      linkExpiryDefaultDays: 30,
    })
    vi.setSystemTime(new Date(2026, 9, 20, 0, 1))

    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    await clickFooterButton('visibilityDialog.save')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      visibility: 'link',
    })
  })

  test.each([
    {
      policy: 'unlimited-capable',
      linkExpiryMaxDays: null,
      expectedMessage: 'visibilityDialog.link.expiryRequiredOrUnlimited',
      showsUnlimited: true,
    },
    {
      policy: 'finite-only',
      linkExpiryMaxDays: 90,
      expectedMessage: 'visibilityDialog.link.expiryRequired',
      showsUnlimited: false,
    },
  ])(
    'rejects a malformed finite date without posting an unlimited expiry ($policy)',
    async ({ linkExpiryMaxDays, expectedMessage, showsUnlimited }) => {
      await renderDialog({
        currentVisibility: 'link',
        linkExpiresAt: '2026-10-19T07:12:34.567Z',
        linkExpiryDefaultDays: 30,
        linkExpiryMaxDays,
      })
      const expiryInput =
        host.querySelector<HTMLInputElement>('input[type="date"]')!
      const initialDescription = expectExpiryAccessibility(expiryInput, '')
      expiryInput.type = 'text'
      await changeInput(expiryInput, '20260-10-20')
      expect(expiryInput.value).toBe('20260-10-20')
      expect(Boolean(host.querySelector('input[type="checkbox"]'))).toBe(
        showsUnlimited,
      )
      expect(expiryInput.getAttribute('aria-invalid')).toBe('true')
      expect(expectExpiryAccessibility(expiryInput, expectedMessage)).toBe(
        initialDescription,
      )
      expect(host.querySelector('[role="alert"]')).toBeNull()

      const save = Array.from(host.querySelectorAll('footer button')).find(
        (button) => button.textContent === 'visibilityDialog.save',
      ) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      await React.act(async () => save.click())
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test('revalidates an old artifact save after remount without closing the new dialog', async () => {
    const artifactASave = deferred<Response>()
    fetchMock.mockReturnValueOnce(artifactASave.promise)
    await renderDialog({
      shareableId: 'artifact-a',
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-visibility="private"]')
        ?.click()
    })
    await clickFooterButton('visibilityDialog.save')

    await renderDialog({
      shareableId: 'artifact-b',
      currentVisibility: 'private',
      linkExpiresAt: null,
      linkExpiryDefaultDays: 30,
    })
    await React.act(async () => {
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')?.click()
    })
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe(addDaysToLocalDate(30))

    await React.act(async () =>
      artifactASave.resolve(
        saveResponse({ visibility: 'private', link_expires_at: null }),
      ),
    )
    expect(revalidate).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(
      host.querySelector<HTMLButtonElement>('[data-visibility="link"]')
        ?.disabled,
    ).toBe(false)
  })

  test('keeps a cleared finite expiry empty and prevents saving it', async () => {
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: '2026-10-19T07:12:34.567Z',
      linkExpiryDefaultDays: 30,
    })
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    await changeInput(expiryInput, '')

    expect(expiryInput.value).toBe('')
    const save = Array.from(host.querySelectorAll('footer button')).find(
      (button) => button.textContent === 'visibilityDialog.save',
    ) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await React.act(async () => save.click())
    expect(fetchMock).not.toHaveBeenCalled()

    const finiteDate = '2026-10-20'
    await changeInput(expiryInput, finiteDate)
    expect(save.disabled).toBe(false)
  })

  test('requires a date when changing an unlimited link to finite expiry', async () => {
    await renderDialog({
      currentVisibility: 'link',
      linkExpiresAt: null,
      linkExpiryDefaultDays: null,
    })
    const unlimited = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')!
    const expiryDescription = expectExpiryAccessibility(expiryInput, '')

    await React.act(async () => unlimited.click())
    const save = Array.from(host.querySelectorAll('footer button')).find(
      (button) => button.textContent === 'visibilityDialog.save',
    ) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(expiryInput.getAttribute('aria-invalid')).toBe('true')
    expect(
      expectExpiryAccessibility(
        expiryInput,
        'visibilityDialog.link.expiryRequiredOrUnlimited',
      ),
    ).toBe(expiryDescription)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await React.act(async () => save.click())
    expect(fetchMock).not.toHaveBeenCalled()

    const finiteDate = '2026-10-20'
    await changeInput(expiryInput, finiteDate)
    expect(save.disabled).toBe(false)
    expect(expiryInput.hasAttribute('aria-invalid')).toBe(false)
    expect(expectExpiryAccessibility(expiryInput, '')).toBe(expiryDescription)
    await React.act(async () => save.click())

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      link_expires_at: localDateEndAsUtc(finiteDate),
    })
  })

  function clickFooterButton(label: string) {
    const button = Array.from(
      host.querySelectorAll<HTMLButtonElement>('footer button'),
    ).find((candidate) => candidate.textContent === label)
    return React.act(async () => button?.click())
  }

  function expectSavingControls(saving: boolean) {
    for (const button of host.querySelectorAll<HTMLButtonElement>(
      '[data-visibility]',
    )) {
      expect(button.disabled).toBe(saving)
    }
    const expiryInput =
      host.querySelector<HTMLInputElement>('input[type="date"]')
    if (expiryInput) expect(expiryInput.disabled).toBe(saving)
    const unlimitedInput = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    if (unlimitedInput) expect(unlimitedInput.disabled).toBe(saving)
    expect(
      host.querySelector('section')?.getAttribute('data-show-close-button'),
    ).toBe('true')
  }

  function expectSavingStatus(saving: boolean) {
    const status = host.querySelector<HTMLElement>('footer [role="status"]')!
    expect(status.textContent).toBe(saving ? 'visibilityDialog.saving' : '')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.classList.contains('sr-only')).toBe(!saving)
    return status
  }

  function expectExpiryAccessibility(
    input: HTMLInputElement,
    description: string,
  ) {
    expect(input.labels).toHaveLength(1)
    expect(input.labels?.[0]?.textContent).toBe('visibilityDialog.link.expiry')
    const descriptionId = input.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    const descriptionElement = document.getElementById(descriptionId!)!
    expect(descriptionElement.textContent).toBe(description)
    expect(descriptionElement.getAttribute('role')).toBe('status')
    expect(descriptionElement.getAttribute('aria-live')).toBe('polite')
    expect(descriptionElement.classList.contains('sr-only')).toBe(
      description === '',
    )
    return descriptionElement
  }
})

async function changeInput(input: HTMLInputElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function saveResponse({
  visibility,
  link_expires_at,
}: {
  visibility: string
  link_expires_at: string | null
}) {
  return Response.json({ visibility, grants: [], link_expires_at })
}
