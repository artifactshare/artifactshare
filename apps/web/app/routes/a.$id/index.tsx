import ViewerRoute, { ErrorBoundary as ViewerErrorBoundary } from './+viewer'

export { loader } from './+loader.server'
export { meta, AgentHelpContent, buildPreauthCliOpenCommand } from './+viewer'

// Direct component exports let React Router inject loader and error props.
export default ViewerRoute
export const ErrorBoundary = ViewerErrorBoundary
