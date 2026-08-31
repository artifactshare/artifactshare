import { ViewerChrome } from '~/routes/a.$id/+components/viewer-chrome'
import { DropCatcher } from '~/routes/a.$id/+components/drop-catcher'
import {
  sandboxFrameSurfaceClassName,
  ViewerBodySurface,
} from '~/routes/a.$id/+components/sandbox-frame'

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

const VIEWER_PRESENCE = [
  {
    id: 'fixture-present-user',
    name: 'Present collaborator',
    image: null,
    initial: 'P',
  },
] as const

export function ViewerFixture({
  tooltipOpen = false,
  movable = false,
}: { tooltipOpen?: boolean; movable?: boolean } = {}) {
  const artifact = movable
    ? {
        ...VIEWER_ARTIFACT,
        canMove: true,
      }
    : VIEWER_ARTIFACT
  return (
    <div className="bg-surface-warm fixed inset-0 flex flex-col overflow-hidden overscroll-none">
      <ViewerChrome
        artifact={artifact}
        user={tooltipOpen || movable ? VIEWER_USER : null}
        renderType="md"
        collapsible={tooltipOpen}
        presence={movable ? VIEWER_PRESENCE : undefined}
        onCommentsOpen={() => undefined}
      />
      <ViewerBodySurface data-regression-region="main">
        <iframe
          title="Unstyled HTML artifact"
          className={sandboxFrameSurfaceClassName(false)}
          sandbox=""
          srcDoc={`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Review notes</title></head>
  <body>
    <main style="max-width: 48rem; margin: 0 auto; padding: 2.5rem 1.5rem; font-family: system-ui, sans-serif">
      <small>Fixture document</small>
      <h2>Review notes</h2>
      <p>This HTML artifact intentionally leaves its background, text color, and color scheme unspecified.</p>
      <ul>
        <li>Its default text remains readable in either app theme.</li>
        <li>The viewer chrome continues to follow the selected app theme.</li>
      </ul>
    </main>
  </body>
</html>`}
        />
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

export function ViewerMoveFixture() {
  return <ViewerFixture movable />
}
