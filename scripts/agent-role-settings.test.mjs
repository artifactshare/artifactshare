import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentRoleSettings,
  finalReviews,
  initialImplementation,
  orchestration,
  reviewFindingRepairs,
  roundCapConsultation,
  specificationAuthoring,
  specificationReviews,
  uiCritique,
} from './agent-role-settings.mjs'
import {
  defaultEffort as codexEffort,
  defaultModel as codexModel,
} from './codex-review.mjs'
import {
  defaultEffort as claudeEffort,
  defaultModel as claudeModel,
} from './claude-review.mjs'

test('role settings are deeply frozen data consumed by review launchers', () => {
  assert.equal(Object.isFrozen(agentRoleSettings), true)
  assert.equal(Object.isFrozen(finalReviews), true)
  assert.equal(Object.isFrozen(finalReviews.codex), true)
  assert.equal(Object.isFrozen(initialImplementation), true)
  assert.equal(Object.isFrozen(initialImplementation.codex), true)
  assert.equal(codexModel, finalReviews.codex.model)
  assert.equal(codexEffort, finalReviews.codex.effort)
  assert.equal(claudeModel, finalReviews.claude.model)
  assert.equal(claudeEffort, finalReviews.claude.effort)
})

test('the Claude final review runs /code-review high and the cap consults Fable', () => {
  assert.deepEqual(finalReviews, {
    codex: { model: 'gpt-6-sol', effort: 'medium' },
    claude: { model: 'claude-opus-5-5', effort: 'high' },
  })
  assert.deepEqual(roundCapConsultation, {
    claude: { model: 'claude-fable-5-1', effort: 'medium' },
  })
})

test('initial implementation uses one Astra profile', () => {
  assert.deepEqual(initialImplementation, {
    codex: { model: 'gpt-6-astra', effort: 'medium' },
  })
})

test('orchestration and specification roles keep their approved pairs', () => {
  assert.deepEqual(orchestration, {
    primary: { model: 'gpt-6-sol', effort: 'medium' },
    routine: { model: 'gpt-6-luna', effort: 'max' },
    claude: { model: 'claude-opus-5-5', effort: 'medium' },
  })
  assert.deepEqual(specificationAuthoring, {
    codex: { model: 'gpt-6-sol', effort: 'medium' },
  })
  assert.deepEqual(specificationReviews, {
    codex: { model: 'gpt-6-sol', effort: 'medium' },
    claude: { model: 'claude-opus-5-5', effort: 'medium' },
  })
})

test('review-finding repairs use Astra and Claude at medium', () => {
  assert.deepEqual(reviewFindingRepairs, {
    codex: { model: 'gpt-6-astra', effort: 'medium' },
    claude: { model: 'claude-opus-5-5', effort: 'medium' },
  })
  assert.equal(Object.isFrozen(reviewFindingRepairs.codex), true)
})

test('UI aliases remain separate from the final implementation pair', () => {
  assert.equal(uiCritique.codex.model, 'gpt-6-astra')
  assert.equal(uiCritique.codex.effort, 'medium')
  assert.equal(uiCritique.claude.visual.model, 'claude-opus-5-5')
  assert.equal(uiCritique.claude.visual.effort, 'medium')
  assert.equal(uiCritique.claude.task.model, 'claude-opus-5-5')
  assert.equal(uiCritique.claude.task.effort, 'medium')
  assert.notEqual(uiCritique.codex.model, finalReviews.codex.model)
})
