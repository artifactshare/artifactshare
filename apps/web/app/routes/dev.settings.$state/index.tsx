import type { Route } from './+types/index'
import TeamMembersPage from '~/routes/_protected/settings/+components/members-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'members')
}

export default TeamMembersPage
