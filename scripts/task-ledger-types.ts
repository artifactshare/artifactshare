import type { TaskLedgerScreenReference } from './task-ledger-screen-references'

export type TaskFlowPhase =
  | 'start'
  | 'action'
  | 'pending'
  | 'success'
  | 'failure'
  | 'recovery'
  | 'next'

export type TaskFlowStage = {
  description: string
  screens: TaskLedgerScreenReference[]
}

export type TaskFlowState = TaskFlowStage & {
  phase: TaskFlowPhase
}

export type TaskFlowInput = {
  start: TaskFlowStage
  action: TaskFlowStage
  pending: TaskFlowStage
  success: TaskFlowStage
  failure: TaskFlowStage
  recovery: TaskFlowStage
  next: TaskFlowStage
}

export type TaskLoopStage = 'publish' | 'share' | 'view' | 'react' | 'republish'

export type TaskPersonaMediation = 'human-direct' | 'agent-mediated' | 'mixed'

export type TaskPersonaAuth =
  | 'anonymous'
  | 'free-owner'
  | 'plus-owner'
  | 'team-owner'
  | 'team-member'

export type TaskPersona = {
  id: string
  name: string
  summary: string
  mediation: TaskPersonaMediation
  auth: TaskPersonaAuth
}

export type Task = {
  id: string
  title: string
  persona: string
  actor: string
  startingSituation: string
  prerequisite: string
  goal: string
  completion: string
  confirmation: string
  /** Current product choices relevant to this task, open to new contrary evidence. */
  acceptedBehavior?: string[]
  loopStage: TaskLoopStage
  metric: string
  flow: TaskFlowState[]
}
