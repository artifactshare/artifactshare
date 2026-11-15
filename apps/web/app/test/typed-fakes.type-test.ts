import type { CliAuthority } from '~/services/cli-authority.server'
import { cliAuthority } from './typed-fakes/cli-authority'
const agent: Extract<CliAuthority, { kind: 'agent' }> = cliAuthority.agent({
  workspaceId: 'ws1',
})
const workspaceId: string = agent.workspaceId
void workspaceId
// @ts-expect-error The production workspace identifier is a string, not a number.
cliAuthority.agent({ workspaceId: 42 })
