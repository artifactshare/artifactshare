// View for the pstack /statechart skill: labels ArtifactAccess states and steps
// in the words of someone who shares artifacts and projects.

export const title = 'What a viewer is shown and what they can open'

export const state = (v) => ({
  Viewer: v.sameWs ? 'In the artifact workspace' : 'From another workspace',
  Project:
    v.kind !== 'project'
      ? 'Artifact not in a project'
      : `${v.projectGrant ? 'In the audience' : 'Not in the audience'}, ${v.joined ? 'joined' : 'not joined'}`,
  History: v.recency ? 'Opened the artifact before' : 'Never opened it',
})

export const group = (v) => (v.joined ? 'joined' : 'not joined')

export const colors = { joined: 'blue', 'not joined': 'tan' }

const LABELS = {
  ChangeVisibility: 'the owner changes who can see the artifact',
  SuspendOrResumeLink: 'an operator pauses or resumes the link',
  ChangeExpiry: 'the link expiry changes or passes',
  ToggleLinkSharing: 'an admin turns link sharing on or off',
  ChangeBaseVisibility: 'the project switches between everyone and invited people',
  ArchiveOrRestoreProject: 'the project is archived or restored',
  ChangeAudience: 'the viewer is added to or removed from the project audience',
  ChangeArtifactGrant: 'the artifact is shared with or unshared from the viewer',
  ChangeMembership: 'the viewer is removed, restored, promoted, or demoted',
  ChangePlan: 'the workspace plan changes',
  StopOrRestartBot: 'the bot is stopped or restarted',
  ChangeEmailVerification: 'the viewer signs in with or without a verified email',
  JoinProject: 'the viewer joins the project',
  LeaveProject: 'the viewer leaves the project',
  ViewArtifact: 'the viewer opens the artifact',
}

export const step = (action) => LABELS[action] ?? null
