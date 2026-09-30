// Keep the approved role pairings in one small, immutable data module. The
// workflow document remains the procedural source for when each pairing is
// used; this file only carries executable model and effort values.

function pair(model, effort) {
  return Object.freeze({ model, effort })
}

const orchestration = Object.freeze({
  primary: pair('gpt-6.1-sol', 'medium'),
  routine: pair('gpt-6-luna', 'max'),
  claude: pair('claude-opus-5-5', 'medium'),
})

const specificationAuthoring = Object.freeze({
  codex: pair('gpt-6.1-sol', 'medium'),
})

const specificationReviews = Object.freeze({
  codex: pair('gpt-6.1-sol', 'medium'),
  claude: pair('claude-opus-5-5', 'medium'),
})

const initialImplementation = Object.freeze({
  codex: pair('gpt-6-astra', 'medium'),
})

const reviewFindingRepairs = Object.freeze({
  codex: pair('gpt-6-astra', 'medium'),
  claude: pair('claude-opus-5-5', 'medium'),
})

// The Claude side runs Claude Code's `/code-review`; its effort is the
// review level, an owner-approved exception to the medium Claude default.
const finalReviews = Object.freeze({
  codex: pair('gpt-6.1-sol', 'medium'),
  claude: pair('claude-opus-5-5', 'high'),
})

// Consulted when blockers remain after the implementation gate's round cap.
const roundCapConsultation = Object.freeze({
  claude: pair('claude-fable-5-1', 'medium'),
})

const supportingExploration = Object.freeze({
  luna: pair('gpt-6-luna', 'max'),
  claude: pair('claude-opus-5-5', 'medium'),
})

const uiCritique = Object.freeze({
  codex: pair('gpt-6-astra', 'medium'),
  claude: Object.freeze({
    visual: pair('claude-opus-5-5', 'medium'),
    task: pair('claude-opus-5-5', 'medium'),
  }),
})

const agentRoleSettings = Object.freeze({
  orchestration,
  specificationAuthoring,
  specificationReviews,
  initialImplementation,
  reviewFindingRepairs,
  finalReviews,
  roundCapConsultation,
  supportingExploration,
  uiCritique,
})

export {
  agentRoleSettings,
  finalReviews,
  initialImplementation,
  orchestration,
  reviewFindingRepairs,
  roundCapConsultation,
  specificationAuthoring,
  specificationReviews,
  supportingExploration,
  uiCritique,
}

export default agentRoleSettings
