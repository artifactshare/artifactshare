import { Topbar } from '~/routes/_home/+components/topbar'
import { RecentContent } from '~/routes/_home/+components/recent-content'
import type { FileRowData } from '~/routes/_home/+components/file-data'
import { listMainClassName } from '~/components/app/page-shell-styles'
import type { UserInfo } from '~/lib/user'

const FIXTURE_USER: UserInfo = {
  id: 'fixture-user',
  email: 'viewer@example.test',
  name: 'Fixture Viewer',
  image: null,
  initial: 'F',
}

function createRecentFixtureFile(
  overrides: Partial<FileRowData> = {},
): FileRowData {
  return {
    id: 'fixture-file',
    fileName: 'fixture.md',
    derivedTitle: null,
    titleOverride: null,
    renderType: 'md',
    ownerEmail: 'author@example.test',
    ownerId: 'fixture-author',
    ownerName: 'Fixture Author',
    ownerImage: null,
    ownerInitial: 'F',
    ownerIsExternal: false,
    modifiedTime: null,
    registeredByMe: true,
    visibility: 'workspace',
    viewCount: 4,
    commentCount: 0,
    ...overrides,
  }
}

export function HomeFixture({ content }: { content: boolean }) {
  const files = content
    ? [
        createRecentFixtureFile({
          id: 'fixture-long-file',
          fileName: 'quarterly-planning-review-with-a-name-that-keeps-going.md',
          derivedTitle: null,
          projectId: 'fixture-project',
          projectName:
            'A project name long enough to test the compact topbar and row boundaries',
        }),
      ]
    : []
  const layoutData = {
    signedIn: true as const,
    workspaceName:
      'A workspace name that is intentionally long for regression coverage',
    selfUploadEnabled: true,
    openUploadDialog: () => undefined,
    user: FIXTURE_USER,
  }
  return (
    <>
      <div data-regression-region="header">
        <Topbar workspaceName={layoutData.workspaceName} user={FIXTURE_USER} />
      </div>
      <main
        data-regression-region="main"
        className={listMainClassName}
        tabIndex={-1}
      >
        <RecentContent layoutData={layoutData} files={files} unreadEnabled />
      </main>
    </>
  )
}
