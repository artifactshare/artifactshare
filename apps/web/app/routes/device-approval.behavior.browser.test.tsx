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
vi.mock('~/lib/auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/auth-client')>()),
  deviceVerify: transport.deviceVerify,
  deviceApprove: transport.deviceApprove,
  deviceDeny: transport.deviceDeny,
  signInToCurrentPage: transport.signInToCurrentPage,
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useSearchParams: () => [deviceParams],
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
let deviceParams = new URLSearchParams()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

async function render(query: string, body: unknown = {}) {
  deviceParams = new URLSearchParams(query)
  transport.deviceVerify.mockResolvedValue({ data: { status: 'pending' } })
  transport.deviceApprove.mockResolvedValue({ data: {} })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => Response.json(body)),
  )
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
}

const approve = () =>
  page.getByRole('button', { name: en['device.approve'], exact: true })
const confirmation = () =>
  page.getByRole('checkbox', { name: en['device.code_confirmation'] })

test.each([
  { agentApproval: null, publisherApproval: null },
  {},
  {
    agentApproval: {
      preset: 'agent',
      deviceName: 'UntrustedSentinel',
      projectSelector: 'Reports',
      fixedProject: null,
      fixedProjectError: true,
    },
  },
  {
    publisherApproval: {
      preset: 'publisher',
      requestedName: 'UntrustedSentinel',
      clients: [],
    },
  },
])('server approval envelope determines disclosure: %j', async (body) => {
  await render(
    'user_code=AB12CD34&preset=agent&device_name=UntrustedSentinel',
    body,
  )
  await expect
    .element(page.getByText(en['device.approval_warning']))
    .toBeVisible()
  if (body.agentApproval || body.publisherApproval) {
    await expect
      .element(page.getByText(en['device.unrestricted_disclosure']))
      .not.toBeInTheDocument()
  } else {
    await expect
      .element(page.getByText(en['device.unrestricted_disclosure']))
      .toBeVisible()
  }
  if (body.publisherApproval) {
    await expect
      .element(page.getByText('UntrustedSentinel', { exact: true }))
      .toBeVisible()
    expect(container!.querySelector('blockquote')?.textContent).toBe(
      'UntrustedSentinel',
    )
    await expect
      .element(page.getByText(en['device.publisher.nameSource']))
      .toBeVisible()
  } else {
    expect(container!.textContent).not.toContain('UntrustedSentinel')
  }
  await expect.element(approve()).toBeDisabled()
  if (body.agentApproval) {
    await expect.element(confirmation()).not.toBeInTheDocument()
    return
  }
  await expect.element(confirmation()).not.toBeChecked()
  await confirmation().click()
  await expect.element(approve()).toBeEnabled()
  await confirmation().click()
  await expect.element(approve()).toBeDisabled()
})

test('manual code entry approves without a checkbox', async () => {
  await render('')
  await page
    .getByRole('textbox', { name: en['device.code_label'] })
    .fill('ab12cd34')
  await expect
    .element(page.getByText(en['device.approval_warning']))
    .toBeVisible()
  await expect
    .element(page.getByText(en['device.unrestricted_disclosure']))
    .toBeVisible()
  await expect.element(confirmation()).not.toBeInTheDocument()
  await approve().click()
  expect(transport.deviceApprove).toHaveBeenCalledWith('AB12CD34', undefined)
})

test('editing a checked prefill uses the new code without retaining confirmation', async () => {
  await render('user_code=AB12CD34')
  await confirmation().click()
  await page
    .getByRole('textbox', { name: en['device.code_label'] })
    .fill('EF56GH78')
  await expect.element(confirmation()).not.toBeInTheDocument()
  await expect.element(approve()).toBeEnabled()
  await approve().click()
  expect(transport.deviceApprove).toHaveBeenCalledWith('EF56GH78', undefined)
})

test.each(['ab12-cd3', 'AB12CD34'])(
  'completing or reformatting query prefill %s still requires confirmation',
  async (prefill) => {
    await render(`user_code=${prefill}`)
    if (prefill === 'AB12CD34') {
      await confirmation().click()
      await expect.element(approve()).toBeEnabled()
    }
    await page
      .getByRole('textbox', { name: en['device.code_label'] })
      .fill('ab12cd34')
    await expect.element(confirmation()).not.toBeChecked()
    await expect.element(approve()).toBeDisabled()
    expect(transport.deviceApprove).not.toHaveBeenCalled()
    await confirmation().click()
    await expect.element(approve()).toBeEnabled()
    await approve().click()
    expect(transport.deviceApprove).toHaveBeenCalledWith('AB12CD34', undefined)
  },
)

test('comparison code stays large on desktop', async () => {
  await page.viewport(1024, 768)
  try {
    await render('user_code=AB12CD34')
    const input = container!.querySelector<HTMLInputElement>('#device-code')!
    expect(getComputedStyle(input).fontSize).toBe('24px')
  } finally {
    await page.viewport(1280, 720)
  }
})
