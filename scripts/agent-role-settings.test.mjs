import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentRoleSettings,
  finalReviews,
  initialImplementation,
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
  assert.equal(Object.isFrozen(initialImplementation.routine), true)
  assert.equal(Object.isFrozen(initialImplementation.complex), true)
  assert.equal(codexModel, finalReviews.codex.model)
  assert.equal(codexEffort, finalReviews.codex.effort)
  assert.equal(claudeModel, finalReviews.claude.model)
  assert.equal(claudeEffort, finalReviews.claude.effort)
})

test('initial implementation routing keeps the two approved scope choices', () => {
  assert.deepEqual(initialImplementation, {
    routine: { model: 'gpt-6-luna', effort: 'max' },
    complex: { model: 'gpt-6-sol', effort: 'medium' },
  })
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
