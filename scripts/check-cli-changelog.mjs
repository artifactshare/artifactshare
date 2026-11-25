import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// packages/cli/src/changelog.ts の SECTION_HEADING と同じ厳密形。緩い形をここで
// 受理すると、CI を通った見出しが実行時の節抽出に一致しない事故 (末尾空白など) が起きる。
const VERSION_HEADING = /^## (\S+) - (\d{4}-\d{2}-\d{2})$/
const LOOSE_HEADING = /^## (\S+) - (.*)$/
const EXPECTED_NAME = '@artifactshare/cli'
const EXPECTED_REPOSITORY =
  'git+https://github.com/artifactshare/artifactshare.git'
const EXPECTED_DIRECTORY = 'packages/cli'
const SEMVER = /^\d+\.\d+\.\d+$/u

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

// Each finding carries the code and the version or heading it is about. The
// executable prints `message`; callers and tests read `code`.
function finding(code, message, detail) {
  return { code, message, ...detail }
}

export function validateCliChangelog(version, changelogContent) {
  const errors = []
  const headings = findVersionHeadings(changelogContent)

  for (const heading of headings) {
    if (!heading.strict) {
      errors.push(
        finding(
          'loose-heading',
          `packages/cli/CHANGELOG.md heading \`${heading.line}\` does not match \`## <version> - YYYY-MM-DD\` exactly (check the date and trailing characters).`,
          { version: heading.version, line: heading.line },
        ),
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
        finding(
          'duplicate-heading',
          `packages/cli/CHANGELOG.md has ${count} headings for version ${headingVersion}; expected exactly one.`,
          { version: headingVersion, count },
        ),
      )
    }
  }

  if (!countByVersion.has(version)) {
    errors.push(
      finding(
        'missing-heading',
        `packages/cli/CHANGELOG.md is missing a \`## ${version} - YYYY-MM-DD\` heading for packages/cli/package.json version ${version}.`,
        { version },
      ),
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
  return { packageJson, changelog }
}

export function checkCliChangelogAtRoot(
  rootUrl = new URL('..', import.meta.url),
) {
  const { packageJson, changelog } = readCliChangelogInputs(rootUrl)
  return validateCliChangelog(packageJson.version, changelog)
}

export function validateCliRelease({ packageJson, changelog, reference }) {
  const errors = []

  if (packageJson.name !== EXPECTED_NAME)
    errors.push(
      finding('package-name', `CLI package name must be ${EXPECTED_NAME}.`),
    )
  if (!SEMVER.test(packageJson.version ?? ''))
    errors.push(
      finding(
        'package-version',
        'CLI package version must be an exact x.y.z version.',
      ),
    )
  if (packageJson.repository?.url !== EXPECTED_REPOSITORY)
    errors.push(
      finding(
        'repository-url',
        `CLI repository.url must be ${EXPECTED_REPOSITORY}.`,
      ),
    )
  if (packageJson.repository?.directory !== EXPECTED_DIRECTORY)
    errors.push(
      finding(
        'repository-directory',
        `CLI repository.directory must be ${EXPECTED_DIRECTORY}.`,
      ),
    )
  if (packageJson.publishConfig?.access !== 'public')
    errors.push(
      finding('publish-access', 'CLI publishConfig.access must be public.'),
    )
  if (reference.package_version !== packageJson.version)
    errors.push(
      finding(
        'reference-version',
        `CLI reference snapshot is for ${reference.package_version ?? 'no version'}; expected ${packageJson.version}. Run pnpm generate:contract-surfaces and format the result.`,
        { version: reference.package_version },
      ),
    )

  errors.push(...validateCliChangelog(packageJson.version ?? '', changelog))
  return errors
}

export function checkCliReleaseAtRoot(
  rootUrl = new URL('..', import.meta.url),
) {
  const { packageJson, changelog } = readCliChangelogInputs(rootUrl)
  const reference = JSON.parse(
    readFileSync(
      new URL('apps/web/app/lib/cli-reference-surface.generated.json', rootUrl),
      'utf8',
    ),
  )
  return validateCliRelease({ packageJson, changelog, reference })
}

function main() {
  const errors = process.argv.includes('--release')
    ? checkCliReleaseAtRoot()
    : checkCliChangelogAtRoot()
  if (errors.length === 0) return

  for (const error of errors) {
    console.error(`[${error.code}] ${error.message}`)
  }
  process.exit(1)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
