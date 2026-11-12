// Bounded local review contract; DOM assertions and real-app controls establish truth.
export const evidenceVersion = 1

export function validateWalkthroughEvidence(
  record,
  manifest,
  validateImage,
  validateVideo,
) {
  const taskId = record.task.id
  const fail = (message) => {
    throw new Error(
      `${taskId}: ${message}. Recapture: pnpm walkthroughs:capture -- --task ${taskId} --label <fresh-label>`,
    )
  }
  if (
    record.evidenceVersion !== evidenceVersion ||
    manifest.evidenceVersion !== evidenceVersion ||
    !record.captureId ||
    record.captureId !== manifest.captureId
  )
    fail('Fresh versioned provenance required')
  const ids = new Set()
  const unique = (id) => {
    if (typeof id !== 'string' || !id || ids.has(id))
      fail('Unique capture-local identity required')
    ids.add(id)
  }
  unique(record.setup?.initializationId)
  if (
    record.setup.reason !== 'setup sign-in' ||
    record.setup.scenario !== record.scenario
  )
    fail('Setup initialization required')
  if (record.runs.length !== 2) fail('Exactly two viewport runs required')
  for (const run of record.runs) {
    if (run.boundaries?.length !== 2 || run.videos?.length !== 2)
      fail('Two branch boundaries and videos required')
    for (const [index, boundary] of run.boundaries.entries()) {
      for (const key of ['branchId', 'contextId', 'initializationId'])
        unique(boundary[key])
      if (
        boundary.branch !== (index === 0 ? 'success' : 'failure-recovery') ||
        boundary.reason !==
          (index === 0
            ? 'viewport initialization'
            : 'independent failure initialization') ||
        boundary.scenario !== record.scenario
      )
        fail('Explicit initialization boundary required')
      const video = run.videos[index]
      if (video.file !== `video/${run.viewport}-${boundary.branch}.webm`)
        fail('Matching branch video required')
      for (const key of [
        'branch',
        'branchId',
        'contextId',
        'initializationId',
        'video',
      ])
        if (video[key] !== boundary[key]) fail('Video provenance mismatch')
      if (video.video !== video.file) fail('Video reference mismatch')
      validateVideo(video.file)
    }
    const supplements = run.supplements ?? []
    if (supplements.length !== (taskId === 'review-new-reactions' ? 1 : 0))
      fail('Continuous Home supplement required only for reactions')
    const ordered = run.steps.flatMap((step) => [
      step,
      ...(step.phase === 'success' ? supplements : []),
    ])
    let previous = null
    for (const step of ordered) {
      unique(step.id)
      const boundary =
        run.boundaries[
          step.phase && ['failure', 'recovery', 'next'].includes(step.phase)
            ? 1
            : 0
        ]
      for (const key of [
        'branch',
        'branchId',
        'contextId',
        'initializationId',
        'video',
      ])
        if (step[key] !== boundary[key]) fail('Step provenance mismatch')
      const continues = previous?.branchId === step.branchId
      if (
        step.predecessorId !== (previous?.id ?? null) ||
        step.continues !== continues ||
        step.resetReason !== (continues ? null : boundary.reason)
      )
        fail('Step continuity mismatch')
      previous = step
    }
    for (const video of run.videos)
      if (
        JSON.stringify(video.stepIds) !==
        JSON.stringify(
          ordered.filter((s) => s.branchId === video.branchId).map((s) => s.id),
        )
      )
        fail('Video step references mismatch')
    for (const supplement of supplements) {
      validateImage(supplement.file)
      if (
        supplement.purpose !== 'home-read' ||
        supplement.file !== `supplement-home-read-${run.viewport}.png` ||
        run.steps.some((s) => s.file === supplement.file)
      )
        fail('Supplement image purpose mismatch')
      const result = supplement.result
      const success = run.steps.find((s) => s.phase === 'success')
      const start = run.steps.find((s) => s.phase === 'start')
      const action = run.steps.find((s) => s.phase === 'action')
      if (
        !result ||
        result.status !== 'passed' ||
        result.inspectionStepId !== success.id ||
        JSON.stringify(result.inspection) !==
          JSON.stringify(success.evidence.inspected) ||
        !result.inspection?.visible ||
        !result.inspection.body?.trim() ||
        result.inspection.selector !==
          '[data-new-comment-thread] [data-new-comment-message]'
      )
        fail('Comment body observation required')
      if (
        JSON.stringify(result.initial) !==
        JSON.stringify(start.evidence.initial)
      )
        fail('Initial observation mismatch')
      const { initial, final, navigation } = result
      if (
        !initial?.artifactId ||
        initial.href !== `/a/${initial.artifactId}` ||
        final?.artifactId !== initial.artifactId ||
        final.href !== initial.href ||
        action.evidence.clicked?.destination !== initial.href ||
        new URL(success.evidence.url).pathname !== initial.href
      )
        fail('Continuous artifact mismatch')
      if (
        initial.visible !== true ||
        initial.unread !== true ||
        initial.newComments !== true ||
        !Array.isArray(initial.commentIndicators) ||
        initial.commentIndicators.length === 0 ||
        final.visible !== true ||
        final.unread !== false ||
        final.newComments !== false ||
        !Array.isArray(final.commentIndicators) ||
        final.commentIndicators.length !== 0 ||
        !initial.text ||
        !final.text
      )
        fail('Continuous DOM observations required')
      if (
        navigation?.kind !== 'app-link' ||
        !navigation.selector ||
        new URL(navigation.url).pathname !== '/' ||
        new URL(navigation.url).origin !== new URL(success.evidence.url).origin
      )
        fail('In-app Home navigation required')
    }
  }
}
