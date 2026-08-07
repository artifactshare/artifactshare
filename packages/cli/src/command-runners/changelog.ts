import { buildChangelogData } from '../changelog.js'
import type { OutputMode, ParsedArgs } from '../types.js'
import { writeSuccess } from '../output.js'
import { loadCliVersion } from '../version.js'

export async function runChangelog(
  _parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const version = await loadCliVersion()
  const data = await buildChangelogData(version)
  return writeSuccess('changelog', data, mode)
}
