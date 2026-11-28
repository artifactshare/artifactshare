import { useResolvedPath } from 'react-router'
import AiToolsPage from '~/routes/_protected/settings/+components/ai-tools-page'
import { SettingsNavigation } from '~/routes/_protected/settings/+components/settings-nav'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { useT } from '~/hooks/use-t'
export function SettingsFixture({
  role = 'owner',
  credentials = false,
}: {
  role?: 'owner' | 'admin' | 'member'
  credentials?: boolean
}) {
  const { t } = useT()
  const tokensPath = useResolvedPath('tokens').pathname
  return (
    <main
      data-regression-region="main"
      className="stack:p-8 mx-auto max-w-6xl p-4"
    >
      <h1 className="mb-6 text-2xl font-semibold">{t('team.settings')}</h1>
      <SettingsNavigation
        pathname={tokensPath}
        currentUserIsAdmin={role !== 'member'}
        workspaceKind={role === 'owner' ? 'upgrade' : 'team'}
      >
        {credentials ? (
          <AiToolsPage
            loaderData={{
              tokens: [
                {
                  id: 'token-a',
                  name: 'Report automation',
                  createdAt: '2026-01-01T00:00:00Z',
                  lastUsedAt: null,
                },
              ],
              createdToken: {
                name: 'Report automation',
                token: 'as_dev_screen_created_secret',
              },
              cliFamilies: [
                {
                  familyId: 'session-a1234567',
                  deviceName: null,
                  publisherClientName: null,
                  preset: 'unrestricted',
                  createdAt: '2026-01-01T00:00:00Z',
                  lastUsedAt: '2026-01-02T00:00:00Z',
                },
                {
                  familyId: 'session-b7654321',
                  deviceName: 'Development workstation for scheduled reports',
                  publisherClientName: null,
                  preset: 'agent',
                  createdAt: '2026-01-01T00:00:00Z',
                  lastUsedAt: '2026-01-02T00:00:00Z',
                },
              ],
            }}
          />
        ) : (
          <SettingsPage>
            <SettingsSection
              title={t('settings.connections')}
              description={t('settings.connections.body')}
            />
          </SettingsPage>
        )}
      </SettingsNavigation>
    </main>
  )
}
