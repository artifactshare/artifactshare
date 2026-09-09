// Keep the approved role pairings in one small, immutable data module. The
// workflow document remains the procedural source for when each pairing is
// used; this file only carries executable model and effort values.

function pair(model, effort) {
  return Object.freeze({ model, effort })
}

const orchestration = Object.freeze({
  primary: pair('gpt-6-astra', 'medium'),
  routine: pair('gpt-6-astra', 'low'),
})

const specificationDrafting = Object.freeze({
  codex: pair('gpt-5.6-sol', 'medium'),
  claude: pair('claude-opus-5', 'high'),
})

const initialImplementation = Object.freeze({
  routine: pair('gpt-5.6-luna', 'max'),
  complex: pair('gpt-5.6-sol', 'medium'),
})

const reviewFindingRepairs = Object.freeze({
  codex: pair('gpt-5.6-sol', 'medium'),
  claude: pair('claude-opus-5', 'xhigh'),
})

const finalReviews = Object.freeze({
  codex: pair('gpt-5.6-sol', 'medium'),
  claude: pair('claude-opus-5', 'high'),
})

const supportingExploration = Object.freeze({
  luna: pair('gpt-5.6-luna', 'max'),
  sonnet: pair('claude-sonnet-5', 'xhigh'),
})

const uiCritique = Object.freeze({
  codex: pair('gpt-6-astra', 'medium'),
  claude: Object.freeze({
    visual: pair('opus', 'high'),
    task: pair('fable', 'low'),
  }),
})

const agentRoleSettings = Object.freeze({
  orchestration,
  specificationDrafting,
  initialImplementation,
  reviewFindingRepairs,
  finalReviews,
  supportingExploration,
  uiCritique,
})

export {
  agentRoleSettings,
  finalReviews,
  initialImplementation,
  orchestration,
  reviewFindingRepairs,
  specificationDrafting,
  supportingExploration,
  uiCritique,
}

export default agentRoleSettings
