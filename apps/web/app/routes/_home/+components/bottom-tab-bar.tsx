import { NavLink } from 'react-router'
import { useT } from '~/hooks/use-t'
import { primaryNavItems } from './primary-nav'

export function BottomTabBar() {
  const { t } = useT()
  return (
    <nav
      aria-label={t('tb.homeView')}
      className="bg-background border-divider max-nav:flex fixed inset-x-0 bottom-0 z-(--z-topbar) hidden h-14 items-stretch justify-around border-t pb-[var(--spacing-1)]"
    >
      {primaryNavItems.map(([to, key, Icon]) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className="text-muted-foreground aria-[current=page]:text-foreground flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs aria-[current=page]:font-medium"
          aria-label={t(key)}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{t(key)}</span>
        </NavLink>
      ))}
    </nav>
  )
}
