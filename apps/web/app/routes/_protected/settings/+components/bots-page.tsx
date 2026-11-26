import { SettingsPage } from '~/components/form/settings-page'
import type { WorkspaceBotRow } from '~/services/bot-members.server'
import { BotSection } from './bot-section'

export interface BotsLoaderData {
  bots: WorkspaceBotRow[]
  botCreationEnabled: boolean
}

export default function BotsPage({
  loaderData,
}: {
  loaderData: BotsLoaderData
}) {
  return (
    <SettingsPage>
      <BotSection
        bots={loaderData.bots}
        canCreate={loaderData.botCreationEnabled}
      />
    </SettingsPage>
  )
}
