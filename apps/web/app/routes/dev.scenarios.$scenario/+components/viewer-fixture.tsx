import { ViewerChrome } from '~/routes/a.$id/+components/viewer-chrome'
import { DropCatcher } from '~/routes/a.$id/+components/drop-catcher'
import { ViewerBodySurface } from '~/routes/a.$id/+components/sandbox-frame'

const VIEWER_ARTIFACT = {
  id: 'fixture-viewer',
  storageKey: 'fixture-viewer.md',
  name: '日本語でとても長い成果物タイトルの省略表示を確認する回帰テスト用ドキュメント.md',
  derivedTitle: null,
  titleOverride: null,
  ownerId: 'fixture-author',
  ownerName: 'Fixture Author',
  ownerEmail: 'author@example.test',
  ownerImage: null,
  ownerInitial: 'F',
  modifiedTime: null,
  viewCount: 8,
  visibility: 'link' as const,
  projectId: 'fixture-project',
  projectName:
    'A project name that should truncate without moving the viewer actions',
  canReplaceFile: false,
  canViewHistory: false,
  canChangeVisibility: false,
  canMove: false,
}

const VIEWER_USER = {
  id: 'fixture-viewer-user',
  email: 'viewer@example.test',
  name: 'Fixture Viewer',
  image: null,
  initial: 'V',
}

export function ViewerFixture({
  tooltipOpen = false,
}: { tooltipOpen?: boolean } = {}) {
  return (
    <div className="bg-surface-warm fixed inset-0 flex flex-col overflow-hidden overscroll-none">
      <ViewerChrome
        artifact={VIEWER_ARTIFACT}
        user={tooltipOpen ? VIEWER_USER : null}
        renderType="md"
        collapsible={tooltipOpen}
      />
      <ViewerBodySurface data-regression-region="main">
        <div className="bg-background h-full overflow-auto">
          <article className="text-foreground mx-auto max-w-3xl px-6 py-10">
            <p className="text-muted-foreground text-sm">Fixture document</p>
            <h2 className="mt-2 text-3xl font-semibold">Review notes</h2>
            <p className="text-muted-foreground mt-4 leading-relaxed">
              This fixed viewer body represents a rendered document without an
              iframe, comments panel, dialog, popover, or remote connection.
            </p>
            <ul className="text-muted-foreground mt-6 list-disc space-y-2 pl-6">
              <li>Long titles stay inside the viewer chrome.</li>
              <li>The file drop overlay stays inside the document viewport.</li>
            </ul>
          </article>
        </div>
        <DropCatcher
          active
          onActiveChange={() => undefined}
          onFinish={() => undefined}
          onDrop={() => undefined}
          regressionOverlay="drop-catcher"
        />
      </ViewerBodySurface>
    </div>
  )
}

export function ViewerTooltipFixture() {
  return <ViewerFixture tooltipOpen />
}
