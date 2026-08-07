import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// packages/cli/src/changelog.ts の SECTION_HEADING と同じ厳密形。緩い形をここで
// 受理すると、CI を通った見出しが実行時の節抽出に一致しない事故 (末尾空白など) が起きる。
const VERSION_HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})$/
const LOOSE_HEADING = /^## (\S+) - (.*)$/

export function findVersionHeadings(changelogContent) {
  const headings = []
  for (const line of changelogContent.split('\n')) {
    const match = line.match(LOOSE_HEADING)
    if (!match) continue
    headings.push({
      version: match[1],
      strict: VERSION_HEADING.test(line),
      line,
    })
  }
  return headings
}

export function validateCliChangelog(version, changelogContent) {
  const errors = []
  const headings = findVersionHeadings(changelogContent)

  for (const heading of headings) {
    if (!heading.strict) {
      errors.push(
        `packages/cli/CHANGELOG.md heading \`${heading.line}\` does not match \`## <version> - YYYY-MM-DD\` exactly (check the date and trailing characters).`,
      )
    }
  }

  const countByVersion = new Map()
  for (const heading of headings) {
    countByVersion.set(
      heading.version,
      (countByVersion.get(heading.version) ?? 0) + 1,
    )
  }
  for (const [headingVersion, count] of countByVersion) {
    if (count > 1) {
      errors.push(
        `packages/cli/CHANGELOG.md has ${count} headings for version ${headingVersion}; expected exactly one.`,
      )
    }
  }

  if (!countByVersion.has(version)) {
    errors.push(
      `packages/cli/CHANGELOG.md is missing a \`## ${version} - YYYY-MM-DD\` heading for packages/cli/package.json version ${version}.`,
    )
  }

  return errors
}

function readCliChangelogInputs(rootUrl) {
  const packageJson = JSON.parse(
    readFileSync(new URL('packages/cli/package.json', rootUrl), 'utf8'),
  )
  const changelog = readFileSync(
    new URL('packages/cli/CHANGELOG.md', rootUrl),
    'utf8',
  )
  return { version: packageJson.version, changelog }
}

export function checkCliChangelogAtRoot(
  rootUrl = new URL('..', import.meta.url),
) {
  const { version, changelog } = readCliChangelogInputs(rootUrl)
  return validateCliChangelog(version, changelog)
}

function main() {
  const errors = checkCliChangelogAtRoot()
  if (errors.length === 0) return

  for (const error of errors) {
    console.error(error)
  }
  process.exit(1)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
