import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AvatarMenu } from './avatar-menu'

const { fetchMock, submitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  submitMock: vi.fn(),
}))
let loaderData: {
  appTheme: 'system'
  updatesNotice?: { slug?: string; dot: boolean; new: boolean }
}
let openChange: ((open: boolean) => void) | undefined
let updatesClick: (() => void | Promise<void>) | undefined

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) => key,
    tPlural: (key: string, n: number) => `${n}`,
  }),
}))

vi.mock('react-router', () => ({
  useFetcher: () => ({ formData: null, submit: submitMock }),
  useNavigate: () => vi.fn(),
  useRouteLoaderData: () => loaderData,
}))

vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    openChange = onOpenChange
    return <div>{children}</div>
  },
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void | Promise<void>
  }) => {
    if (
      Array.isArray(children) &&
      children.some((child) => child === 'updates.pageTitle')
    ) {
      updatesClick = onClick
    }
    return <div>{children}</div>
  },
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: () => null,
  DropdownMenuSubTrigger: () => null,
  DropdownMenuSubContent: () => null,
  DropdownMenuRadioGroup: () => null,
  DropdownMenuRadioItem: () => null,
}))

vi.mock('~/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: () => null,
}))

describe('AvatarMenu', () => {
  beforeEach(() => {
    loaderData = { appTheme: 'system' }
    openChange = undefined
    updatesClick = undefined
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(null))
    vi.stubGlobal('fetch', fetchMock)
    submitMock.mockReset()
  })

  test('forwards layout className to the trigger and labels the account', () => {
    const html = renderToStaticMarkup(
      <AvatarMenu
        user={{
          id: 'user-1',
          email: 'user@example.com',
          name: 'User',
          image: 'https://example.com/avatar.png',
          initial: 'U',
        }}
        variant="viewer"
        className="max-phone:col-start-2 max-phone:justify-self-end ml-auto"
      />,
    )

    expect(html).toContain('ml-auto')
    expect(html).toContain('aria-label="user@example.com"')
  })

  test('shows the accessible dot and NEW badge, then notices optimistically on open', () => {
    loaderData = {
      appTheme: 'system',
      updatesNotice: { dot: true, new: true },
    }
    const html = renderToStaticMarkup(
      <AvatarMenu
        user={{
          id: 'user-1',
          email: 'user@example.com',
          name: 'User',
          image: null,
          initial: 'U',
        }}
      />,
    )

    expect(html).toContain('updates.newAccessible')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('updates.new')

    openChange?.(true)
    expect(fetchMock).toHaveBeenCalledWith('/notice-updates', {
      method: 'POST',
    })
  })

  test('waits for noticing before opening Updates', async () => {
    loaderData = {
      appTheme: 'system',
      updatesNotice: { dot: true, new: true },
    }
    let finishNotice: (() => void) | undefined
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        finishNotice = () => resolve(new Response(null))
      }),
    )
    const assignMock = vi.fn()
    vi.stubGlobal('window', { location: { assign: assignMock } })

    renderToStaticMarkup(
      <AvatarMenu
        user={{
          id: 'user-1',
          email: 'user@example.com',
          name: 'User',
          image: null,
          initial: 'U',
        }}
      />,
    )

    openChange?.(true)
    const opening = updatesClick?.()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(assignMock).not.toHaveBeenCalled()

    finishNotice?.()
    await opening
    expect(assignMock).toHaveBeenCalledWith('/updates')
  })
})
