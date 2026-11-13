import { AvatarMenuTrigger } from './avatar-menu-trigger'
import { useFetcher, useNavigate, useRouteLoaderData } from 'react-router'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '~/components/ui/dropdown-menu'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'
import { useT } from '~/hooks/use-t'
import {
  isSupportedLocale,
  LOCALE_LABEL,
  SUPPORTED_LOCALES,
} from '~/i18n/messages'
import { signOut } from '~/lib/auth-client'
import { withLang } from '~/lib/connect-link'
import type { UserInfo } from '~/lib/user'
import { DEFAULT_APP_THEME, isAppTheme, type AppTheme } from '~/lib/app-theme'
import { AccessRequestsSheet } from '~/components/app/access-requests-sheet'
import type { SidePanelTopbar } from '~/components/app/app-side-panel'

interface AvatarMenuProps {
  user: UserInfo
  variant?: 'default' | 'viewer'
  className?: string
  initialAccessRequestId?: string | null
  accessRequestsOpen?: boolean
  onAccessRequestsOpenChange?: (open: boolean) => void
  onAccessRequestDismiss?: () => void
  onAccessRequestsOpen?: () => void
  topbarCollapsed?: boolean
  accessRequestsTopbar?: SidePanelTopbar
}

async function handleSignOut() {
  await signOut()
  // Hard reload so the loader re-runs without the session cookie.
  window.location.href = '/'
}

export function AvatarMenu({
  user,
  variant = 'default',
  className,
  initialAccessRequestId = null,
  accessRequestsOpen: controlledAccessRequestsOpen,
  onAccessRequestsOpenChange,
  onAccessRequestDismiss,
  onAccessRequestsOpen,
  topbarCollapsed = false,
  accessRequestsTopbar,
}: AvatarMenuProps) {
  const { t, locale } = useT()
  const { openBanner } = useAnalyticsConsent()
  const rootData = useRouteLoaderData<{
    appTheme?: AppTheme
    updatesNotice?: { slug?: string; dot: boolean; new: boolean }
    accessRequestNotice?: { count: number }
  }>('root')
  const fetcher = useFetcher()
  const navigate = useNavigate()
  const resolvedAppTheme = isAppTheme(rootData?.appTheme)
    ? rootData.appTheme
    : DEFAULT_APP_THEME
  const submittedAppTheme = fetcher.formData?.get('theme')
  const appTheme = isAppTheme(submittedAppTheme)
    ? submittedAppTheme
    : resolvedAppTheme
  const [menuOpen, setMenuOpen] = useState(false)
  const [localAccessRequestsOpen, setLocalAccessRequestsOpen] = useState(
    initialAccessRequestId !== null,
  )
  const accessRequestsOpen =
    controlledAccessRequestsOpen ?? localAccessRequestsOpen
  const setAccessRequestsOpen = (open: boolean) => {
    if (controlledAccessRequestsOpen === undefined)
      setLocalAccessRequestsOpen(open)
    onAccessRequestsOpenChange?.(open)
  }
  const [accessRequestCount, setAccessRequestCount] = useState(
    rootData?.accessRequestNotice?.count ?? 0,
  )
  const [showDot, setShowDot] = useState(rootData?.updatesNotice?.dot ?? false)
  const [showNew, setShowNew] = useState(rootData?.updatesNotice?.new ?? false)
  const noticeRequest = useRef<Promise<void> | null>(null)
  const openingAccessRequests = useRef(false)

  useEffect(() => {
    setShowDot(rootData?.updatesNotice?.dot ?? false)
    setShowNew(rootData?.updatesNotice?.new ?? false)
    noticeRequest.current = null
  }, [
    rootData?.updatesNotice?.slug,
    rootData?.updatesNotice?.dot,
    rootData?.updatesNotice?.new,
  ])

  useEffect(() => {
    setAccessRequestCount(rootData?.accessRequestNotice?.count ?? 0)
  }, [rootData?.accessRequestNotice?.count])

  const refreshAccessRequestCount = () => {
    void fetch('/api/access-requests/count')
      .then(async (response) =>
        response.ok ? ((await response.json()) as { count?: unknown }) : null,
      )
      .then((data) => {
        if (typeof data?.count === 'number') setAccessRequestCount(data.count)
      })
      .catch(() => undefined)
  }

  const noticeUpdates = () => {
    if (!noticeRequest.current) {
      noticeRequest.current = fetch('/notice-updates', { method: 'POST' }).then(
        () => undefined,
        () => undefined,
      )
    }
    return noticeRequest.current
  }

  const handleUpdatesOpen = async () => {
    setShowDot(false)
    setShowNew(false)
    await noticeUpdates()
    window.location.assign(withLang('/updates', locale))
  }

  const handleLocaleChange = (next: string) => {
    if (!isSupportedLocale(next) || next === locale) return
    fetcher.submit(
      { locale: next, next: window.location.pathname },
      { method: 'POST', action: '/set-locale' },
    )
  }

  const handleAppThemeChange = (next: string) => {
    if (!isAppTheme(next) || next === appTheme) return
    document.documentElement.dataset.theme = next
    fetcher.submit({ theme: next }, { method: 'POST', action: '/set-theme' })
  }

  const handleAccessRequestsOpen = () => {
    openingAccessRequests.current = true
    onAccessRequestsOpen?.()
    setAccessRequestsOpen(true)
  }

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          if (open && showDot) {
            setShowDot(false)
            void noticeUpdates()
          }
          if (open && rootData?.accessRequestNotice) {
            refreshAccessRequestCount()
          }
        }}
      >
        <AvatarMenuTrigger
          user={user}
          variant={variant}
          className={className}
          accessRequestCount={accessRequestCount}
          showDot={showDot}
        />
        <DropdownMenuContent
          align="end"
          className="w-56"
          onCloseAutoFocus={(event) => {
            if (!openingAccessRequests.current) return
            openingAccessRequests.current = false
            event.preventDefault()
          }}
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              {user.name && <span className="font-medium">{user.name}</span>}
              <span className="text-muted-foreground text-xs">
                {user.email}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-access-requests-menu-item
            onSelect={handleAccessRequestsOpen}
          >
            {t('accessRequests.title')}
            {accessRequestCount > 0 && (
              <Badge variant="info" className="ml-auto">
                {accessRequestCount}
              </Badge>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => navigate(withLang('/connect', locale))}
          >
            {t('menu.connect')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => navigate(withLang('/privacy', locale))}
          >
            {t('lp.privacy')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => navigate(withLang('/terms', locale))}
          >
            {t('lp.terms')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleUpdatesOpen}>
            {t('updates.pageTitle')}
            {showNew && (
              <Badge variant="info" className="ml-auto">
                {t('updates.new')}
              </Badge>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openBanner()}>
            {t('analyticsConsent.change')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t('menu.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={locale}
                onValueChange={handleLocaleChange}
              >
                {SUPPORTED_LOCALES.map((l) => (
                  <DropdownMenuRadioItem key={l} value={l}>
                    {LOCALE_LABEL[l]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t('menu.appTheme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={appTheme}
                onValueChange={handleAppThemeChange}
              >
                <DropdownMenuRadioItem value="system">
                  {t('menu.appThemeSystem')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">
                  {t('menu.appThemeLight')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  {t('menu.appThemeDark')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            {t('menu.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AccessRequestsSheet
        key={initialAccessRequestId ?? 'list'}
        open={accessRequestsOpen}
        initialRequestId={initialAccessRequestId}
        onOpenChange={(open) => {
          setAccessRequestsOpen(open)
          if (!open && initialAccessRequestId) onAccessRequestDismiss?.()
        }}
        onCountChange={setAccessRequestCount}
        topbar={
          accessRequestsTopbar ??
          (variant === 'viewer' ? (topbarCollapsed ? 'none' : 'viewer') : 'app')
        }
      />
    </>
  )
}
