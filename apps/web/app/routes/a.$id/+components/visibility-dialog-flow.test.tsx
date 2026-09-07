// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const revalidate = vi.hoisted(() => vi.fn())
const buildShareableUrl = vi.hoisted(() =>
  vi.fn(() => 'https://abc123def4.artifactshare.link/'),
)

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
  useCopyState: () => ({ state: 'idle', copy: vi.fn() }),
}))
vi.mock('~/lib/share-url', () => ({ buildShareableUrl }))
vi.mock('~/components/app/visibility-select', () => ({
  VisibilitySelect: ({
    availableVisibilities,
    onSelect,
  }: {
    availableVisibilities: string[]
    onSelect: (visibility: string) => void
  }) => (
    <div>
      {availableVisibilities.map((visibility) => (
        <button
          key={visibility}
          type="button"
          data-visibility={visibility}
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
  }: {
    onCommitGrantInput: (value: string) => void
  }) => (
    <button
      type="button"
      data-add-grant
      onClick={() => onCommitGrantInput('viewer@example.com')}
    >
      Add grant
    </button>
  ),
}))
vi.mock('~/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
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
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    onOpenChange.mockReset()
    revalidate.mockReset()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
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
})

async function changeInput(input: HTMLInputElement, value: string) {
  await React.act(async () => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
