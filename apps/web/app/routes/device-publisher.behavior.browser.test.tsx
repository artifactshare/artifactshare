import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import en from '~/i18n/en.json'
import Device from './device'

const transport = vi.hoisted(() => ({
  deviceVerify: vi.fn(),
  deviceApprove: vi.fn(),
  deviceDeny: vi.fn(),
  loadDeviceAgentApproval: vi.fn(),
  signInToCurrentPage: vi.fn(),
}))
vi.mock('~/lib/auth-client', () => transport)
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useSearchParams: () => [new URLSearchParams('user_code=ABCD1234')],
}))
vi.mock('~/components/app/public-footer', () => ({ PublicFooter: () => null }))
vi.mock('~/components/app/focused-flow-brand', () => ({
  FocusedFlowBrand: () => null,
}))
vi.mock('~/components/app/landing-shell', () => ({
  LandingShell: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  LandingHero: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  vi.resetAllMocks()
})

async function render(clients: Array<{ id: string; name: string }>) {
  transport.deviceVerify.mockResolvedValue({ data: { status: 'pending' } })
  transport.loadDeviceAgentApproval.mockResolvedValue({
    preset: 'publisher',
    requestedName: 'Employee dashboard',
    clients,
  })
  transport.deviceApprove.mockResolvedValue({ data: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <Device
        {...({
          loaderData: { signedIn: true, agentApproval: null },
        } as Parameters<typeof Device>[0])}
      />,
    ),
  )
  await expect
    .element(page.getByText(en['device.publisher.capability']))
    .toBeVisible()
}

test('first client defaults to create-new and labels the requested name', async () => {
  await render([])
  expect(en['device.publisher.capability']).toContain('static sites')
  expect(en['device.publisher.capability']).toContain(
    'permanently delete them or their older versions',
  )
  expect(en['device.publisher.capability']).toContain('you assigned to it')
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeEnabled()
  await expect
    .element(
      page.getByRole('radio', {
        name: en['device.publisher.new'],
        exact: true,
      }),
    )
    .toBeChecked()
  await expect
    .element(
      page.getByRole('radio', {
        name: `${en['device.publisher.continue']} ${en['device.publisher.noneYet']}`,
      }),
    )
    .toBeDisabled()
  await expect
    .element(page.getByText(en['device.publisher.nameHelp']))
    .not.toBeInTheDocument()
  await expect
    .element(page.getByText(en['device.publisher.nameSource']))
    .toBeVisible()
  const name = container!.querySelector('blockquote')!
  expect(name.getAttribute('aria-labelledby')).toBe('publisher-name-label')
  expect(name.textContent).toBe('Employee dashboard')
  expect(getComputedStyle(name).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(name.classList.contains('border-border')).toBe(true)
  await expect
    .element(page.getByText(en['device.publisher.requestedName']))
    .toBeVisible()
  await page
    .getByRole('button', { name: en['device.approve'], exact: true })
    .click()
  expect(transport.deviceApprove).toHaveBeenCalledWith('ABCD1234', undefined, {
    mode: 'create-new',
  })
})

test('duplicate names require explicit continuation and an owned client selection', async () => {
  await render([{ id: 'client1', name: 'Employee dashboard' }])
  await expect
    .element(
      page.getByRole('radio', {
        name: en['device.publisher.new'],
        exact: true,
      }),
    )
    .not.toBeChecked()
  await expect
    .element(
      page.getByRole('radio', {
        name: en['device.publisher.continue'],
        exact: true,
      }),
    )
    .not.toBeChecked()
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeDisabled()
  await expect
    .element(page.getByText(en['device.publisher.nameHelp']))
    .toBeVisible()
  await page
    .getByRole('radio', { name: en['device.publisher.new'], exact: true })
    .click()
  await expect
    .element(page.getByText(en['device.publisher.duplicate']))
    .toBeVisible()
  await expect
    .element(page.getByText(en['device.publisher.nameHelp']))
    .not.toBeInTheDocument()
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeDisabled()
  await page
    .getByRole('radio', { name: en['device.publisher.continue'], exact: true })
    .click()
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeDisabled()
  await expect
    .element(page.getByText(en['device.publisher.nameHelp']))
    .toBeVisible()
  const clientSelect = page.getByRole('combobox', {
    name: en['device.publisher.client'],
    exact: true,
  })
  await expect
    .element(clientSelect)
    .toHaveAttribute('aria-labelledby', 'publisher-client-label')
  await expect
    .element(page.getByText(en['device.publisher.client'], { exact: true }))
    .toHaveAttribute('id', 'publisher-client-label')
  await clientSelect.selectOptions('client1')
  await page
    .getByRole('button', { name: en['device.approve'], exact: true })
    .click()
  expect(transport.deviceApprove).toHaveBeenCalledWith('ABCD1234', undefined, {
    mode: 'continue-existing',
    client_id: 'client1',
  })
})

test('existing clients keep new-client approval deliberate even without a duplicate', async () => {
  await render([{ id: 'client1', name: 'Other dashboard' }])
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeDisabled()
  await page
    .getByRole('radio', { name: en['device.publisher.new'], exact: true })
    .click()
  await expect
    .element(
      page.getByRole('button', { name: en['device.approve'], exact: true }),
    )
    .toBeEnabled()
})
