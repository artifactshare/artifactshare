import { TabNav, TabNavLink } from '~/components/app/tab-nav'
import { useT } from '~/hooks/use-t'

export function HomeTabs() {
  const { t } = useT()
  return (
    <TabNav
      aria-label={t('home.tabsLabel')}
      className="border-divider mb-6 border-b"
    >
      <TabNavLink to="/" end label={t('home.filesTab')} viewTransition />
      <TabNavLink to="/recent" label={t('home.recentTab')} viewTransition />
    </TabNav>
  )
}
