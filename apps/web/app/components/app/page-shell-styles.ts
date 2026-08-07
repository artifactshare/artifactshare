// List-page body shell — centered and responsive. Shared by the app shells
// (home, recent, projects, project detail, archived). Settings uses its own width.
// focus:outline-0 suppresses the ring on programmatic focus (route-return
// focus lands here, not a pointer).
const mainShellBase =
  'mx-auto px-10 pt-6 pb-24 focus:outline-0 max-stack:px-6 max-stack:pt-5 max-stack:pb-20'

export const listMainClassName = `${mainShellBase} max-w-[var(--spacing-list-max)]`

export const settingsMainClassName = `${mainShellBase} max-w-[var(--spacing-settings-max)]`

// Off-screen focus target for route-return focus (home index / recent). Only
// suppresses the focus ring; it carries no box of its own.
export const focusReturnTargetClassName = 'focus:outline-0'
