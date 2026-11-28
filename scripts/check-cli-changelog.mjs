import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The CLI's own changelog parser decides what a version heading is; the
// `artifactshare changelog` command finds the section for its version with it.
// Read that pattern instead of restating it, so this check cannot start
// accepting headings the command will not find.
const CLI_CHANGELOG_PARSER = new URL(
  '../packages/cli/src/changelog.ts',
  import.meta.url,
)
export const VERSION_HEADING = (() => {
  const pattern = readFileSync(CLI_CHANGELOG_PARSER, 'utf8').match(
    /^const SECTION_HEADING = \/(.+)\/[a-z]*$/mu,
  )?.[1]
  if (!pattern)
    throw new Error(
      `Could not read SECTION_HEADING from ${CLI_CHANGELOG_PARSER.pathname}`,
    )
  return new RegExp(pattern, 'u')
})()
// This check's own wider net: a line shaped like a version heading, so a
// heading with a bad date is reported instead of silently ignored. Every line
// VERSION_HEADING accepts must match this too; a test holds that.
export const LOOSE_HEADING = /^## (\S+) - (.*)$/u
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
