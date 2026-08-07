const rebuildBaselineMarker = '0055_d1_name_cutover_clean_rebuild_v2.sql'

export const rebuildBaselineUrl = new URL(
  `./baselines/${rebuildBaselineMarker}`,
  import.meta.url,
)

export function partitionMigrationNames(names) {
  const sorted = names.filter((name) => name.endsWith('.sql')).sort()
  const baselineIndex = sorted.indexOf(rebuildBaselineMarker)
  if (baselineIndex === -1) {
    throw new Error(
      `Migration marker not found: ${rebuildBaselineMarker}`,
    )
  }
  return {
    baselineAndEarlier: sorted.slice(0, baselineIndex + 1),
    afterBaseline: sorted.slice(baselineIndex + 1),
  }
}
