import { Outlet, useOutletContext } from 'react-router'
import type { SettingsLayoutContext } from '../../../_layout'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { TabNav, TabNavLink } from '~/components/app/tab-nav'
import { useT } from '~/hooks/use-t'
export default function InventoryLayout() {
  const { t } = useT()
  const shell = useOutletContext<SettingsLayoutContext>()
  return (
    <SettingsPage>
      <SettingsSection title={t('team.inventory.title')}>
        <TabNav aria-label={t('team.inventory.tabs.label')}>
          <TabNavLink
            to="/settings/inventory/projects"
            label={t('team.inventory.projects')}
            end
          />
          <TabNavLink
            to="/settings/inventory/artifacts"
            label={t('team.inventory.artifacts')}
          />
        </TabNav>
        <Outlet context={shell} />
      </SettingsSection>
    </SettingsPage>
  )
}
