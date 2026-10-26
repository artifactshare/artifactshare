// Loaded only into CLI children. Guard each dispatch, including redirects and
// the CLI's explicit insecure-localhost Agent, before opening a connection.
import { createRequire } from 'node:module'
const require = createRequire(process.env.SKILL_EVAL_OVERLAY_TARGET)
const { Agent, setGlobalDispatcher } = require('undici')
const dispatch = Agent.prototype.dispatch
Agent.prototype.dispatch = function (options, handler) {
  if (new URL(options.origin).origin !== process.env.ARTIFACTSHARE_BASE_URL) {
    throw new Error(
      'Evaluation CLI refused a request outside the approved local origin',
    )
  }
  return dispatch.call(this, options, handler)
}
setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
