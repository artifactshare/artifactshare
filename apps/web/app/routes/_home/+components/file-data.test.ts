import { describe, expect, test } from 'vitest'
import { toFileRowData, type ShareableFileRow } from './file-data'

describe('toFileRowData recent contract', () => {
  test('preserves latest unread comment and attribute metadata', () => {
    const row: ShareableFileRow = {
      id: 's1',
      name: 'report.md',
      derived_title: null,
      title_override: null,
      artifact_kind: 'markdown_page',
      owner_user_id: 'owner',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      visibility: 'project',
      view_count: 1,
      comment_count: 3,
      modified_at: '2026-08-03T00:00:00.000Z',
      unread_comment_summary: JSON.stringify({
        count: 3,
        id: 'message-3',
        author_id: 'author',
        author_name: 'Author',
        author_image: null,
        body: 'Latest body',
        created_at: '2026-08-03T01:00:00.000Z',
      }),
      recent_attribute: 'joined-project',
    }

    expect(toFileRowData(row, 'viewer')).toMatchObject({
      unreadCommentCount: 3,
      unreadCommentRemainingCount: 2,
      recentAttribute: 'joined-project',
      latestUnreadComment: {
        id: 'message-3',
        authorId: 'author',
        authorName: 'Author',
        body: 'Latest body',
        createdAt: '2026-08-03T01:00:00.000Z',
      },
    })
  })

  test('adds a workspace label only for a project in another workspace', () => {
    const row: ShareableFileRow = {
      id: 'cross',
      name: 'cross.html',
      derived_title: null,
      title_override: null,
      artifact_kind: 'html_page',
      owner_user_id: 'owner',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      visibility: 'project',
      view_count: 0,
      comment_count: 0,
      modified_at: null,
      workspace_id: 'ws-viewer',
      project_id: 'project-cross',
      project_name: 'Long project name',
      project_kind: 'project',
      project_workspace_id: 'ws-other',
      project_workspace_name: 'Long workspace name',
    }
    expect(
      toFileRowData(row, 'viewer', {
        includeProject: true,
        currentWorkspaceId: 'ws-viewer',
      }),
    ).toMatchObject({ contextualWorkspaceLabel: 'Long workspace name' })
    expect(
      toFileRowData({ ...row, project_workspace_id: 'ws-viewer' }, 'viewer', {
        includeProject: true,
        currentWorkspaceId: 'ws-viewer',
      }).contextualWorkspaceLabel,
    ).toBeNull()
  })
})
