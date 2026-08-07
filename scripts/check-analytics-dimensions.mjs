import {
  ANALYTICS_CUSTOM_DIMENSIONS,
  ANALYTICS_EVENTS,
  ANALYTICS_KEY_EVENTS,
  ANALYTICS_PARAMS,
  NON_DIMENSION_PARAMS,
} from '../apps/web/app/lib/analytics/events.ts'

export function checkAnalyticsDimensions({
  events,
  params,
  keyEvents,
  dimensions,
  nonDimensionParams,
}) {
  const failures = []
  const duplicate = (values, label) => {
    const seen = new Set()
    for (const value of values) {
      if (seen.has(value)) failures.push(`duplicate ${label}: ${value}`)
      seen.add(value)
    }
  }
  const paramValues = new Set(params)
  const dimensionParams = new Set(
    dimensions.map(({ parameterName }) => parameterName),
  )
  const nonDimensions = new Set(nonDimensionParams)
  for (const { parameterName } of dimensions)
    if (!paramValues.has(parameterName))
      failures.push(`dimension references undefined param: ${parameterName}`)
  for (const param of params)
    if (!dimensionParams.has(param) && !nonDimensions.has(param))
      failures.push(`param has no dimension mapping: ${param}`)
  duplicate(
    dimensions.map(({ parameterName }) => parameterName),
    'dimension parameterName',
  )
  duplicate(
    dimensions.map(({ displayName }) => displayName),
    'dimension displayName',
  )
  duplicate(params, 'param')
  duplicate(events, 'event')
  const eventValues = new Set(events)
  for (const keyEvent of keyEvents)
    if (!eventValues.has(keyEvent))
      failures.push(`key event references undefined event: ${keyEvent}`)
  return failures
}

if (import.meta.main) {
  const failures = checkAnalyticsDimensions({
    events: Object.values(ANALYTICS_EVENTS),
    params: Object.values(ANALYTICS_PARAMS),
    keyEvents: ANALYTICS_KEY_EVENTS,
    dimensions: ANALYTICS_CUSTOM_DIMENSIONS,
    nonDimensionParams: NON_DIMENSION_PARAMS,
  })
  for (const failure of failures)
    console.error(`analytics dimensions: ${failure}`)
  if (failures.length) process.exit(1)
}
