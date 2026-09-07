import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import {
  filterGrantEditorEntries,
  remainingGrantSlotsAfterRestore,
} from '~/components/app/grant-editor-state'
import { MAX_GRANT_EMAILS, parseGrantEmails } from '~/lib/grant-emails'
import type { GrantEntry } from '~/services/shareables.server'
import {
  createVisibilityDialogState,
  getVisibilityDialogGrantView,
  hasLinkExpiryChanges,
  hasVisibilityDialogChanges,
  visibilityDialogReducer,
} from './visibility-dialog-state'
import { VisibilityGrantsSection } from './visibility-grants-section'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      ({
        'visibilityDialog.grants.sectionAria': 'Individual sharing',
        'visibilityDialog.grants.inputPlaceholder': 'Add email addresses',
        'visibilityDialog.grants.addButton': 'Add',
        'visibilityDialog.grants.limitHelp': `Up to ${vars?.limit ?? ''} people`,
        'visibilityDialog.grants.limitReached': `Limit ${vars?.limit ?? ''} reached`,
        'visibilityDialog.grants.header.title.private': 'Private',
        'visibilityDialog.grants.header.count.private': `${vars?.count ?? ''} people`,
        'visibilityDialog.grants.you': '(you)',
        'visibilityDialog.grants.owner': 'Owner',
        'visibilityDialog.grants.removeAria': `Remove ${vars?.email ?? ''}`,
      })[key] ?? key,
  }),
}))

describe('VisibilityGrantsSection', () => {
  test('does not render the disabled notification email checkbox', () => {
    const html = renderToStaticMarkup(
      createElement(VisibilityGrantsSection, {
        selected: 'private',
        shareableId: 'shareable-1',
        workspaceHd: null,
        owner: {
          id: 'owner-1',
          email: 'owner@example.com',
          name: 'Owner',
          image: null,
          initial: 'O',
        },
        grantInput: '',
        saving: false,
        grantLimitReached: false,
        activeGrantCount: 0,
        visibleGrants: [],
        pendingAddEmails: [],
        pendingRemoves: new Set<string>(),
        onGrantInputChange: () => {},
        onCommitGrantInput: () => {},
        onRemoveGrant: () => {},
      }),
    )

    expect(html).not.toContain('as-grants-notify')
    expect(html).not.toContain('Send notification email (coming soon)')
  })
})

describe('parseGrantEmails', () => {
  test('filters the owner email from dialog grant input', () => {
    expect(
      parseGrantEmails(
        'viewer@example.com, OWNER@example.com owner@example.com foo@bar',
        ' owner@example.com ',
      ),
    ).toEqual(['viewer@example.com'])
  })
})

describe('filterGrantEditorEntries', () => {
  test('does not render owner grant rows from stale loader data', () => {
    const grants = [
      {
        email: 'Owner@Example.com',
        grantedAt: '2026-05-22T00:00:00.000Z',
        user: null,
      },
      {
        email: 'viewer@example.com',
        grantedAt: '2026-05-22T00:00:00.000Z',
        user: null,
      },
    ]

    expect(filterGrantEditorEntries(grants, 'owner@example.com')).toEqual([
      grants[1],
    ])
  })
})

describe('visibilityDialogReducer', () => {
  test('tracks a changed link expiry independently from visibility changes', () => {
    const initial = { date: '2026-08-19', unlimited: false }
    let state = createVisibilityDialogState('link', true, {
      linkExpiryDate: initial.date,
      linkExpiryUnlimited: initial.unlimited,
    })
    const view = getVisibilityDialogGrantView(state, [], 'owner@example.com')

    expect(hasVisibilityDialogChanges(state, view, 'link')).toBe(false)
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: '2026-08-20',
    })

    expect(state.linkExpiryUnlimited).toBe(false)
    expect(
      hasVisibilityDialogChanges(
        state,
        view,
        'link',
        hasLinkExpiryChanges(state, initial),
      ),
    ).toBe(true)
  })

  test('treats a restored link expiry date as unchanged', () => {
    const initial = { date: '2026-08-19', unlimited: false }
    let state = createVisibilityDialogState('link', true, {
      linkExpiryDate: initial.date,
      linkExpiryUnlimited: initial.unlimited,
    })
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: '2026-08-20',
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(true)

    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: initial.date,
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(false)
  })

  test('treats a restored unlimited expiry as unchanged', () => {
    const initial = { date: '2026-08-19', unlimited: true }
    let state = createVisibilityDialogState('link', true, {
      linkExpiryDate: initial.date,
      linkExpiryUnlimited: initial.unlimited,
    })
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-unlimited',
      value: false,
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(true)

    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-unlimited',
      value: true,
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(false)
  })

  test('ignores an expiry edit after link visibility is abandoned', () => {
    const initial = { date: '2026-08-19', unlimited: false }
    let state = createVisibilityDialogState('private', true, {
      linkExpiryDate: initial.date,
      linkExpiryUnlimited: initial.unlimited,
    })
    state = visibilityDialogReducer(state, { type: 'select', value: 'link' })
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: '2026-08-20',
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(true)

    state = visibilityDialogReducer(state, {
      type: 'select',
      value: 'private',
    })
    expect(hasLinkExpiryChanges(state, initial)).toBe(false)
  })

  test('resets unsaved dialog changes when the dialog is opened again', () => {
    let state = createVisibilityDialogState('private', false)
    state = visibilityDialogReducer(state, {
      type: 'select',
      value: 'workspace',
    })
    state = visibilityDialogReducer(state, {
      type: 'set-grant-input',
      value: 'viewer@example.com',
    })
    state = visibilityDialogReducer(state, {
      type: 'add-pending-grants',
      emails: ['viewer@example.com'],
    })
    state = visibilityDialogReducer(state, {
      type: 'sync-open',
      open: true,
      currentVisibility: 'private',
    })

    expect(state.selected).toBe('private')
    expect(state.grants.input).toBe('')
    expect(state.grants.pendingAdds).toEqual([])
    expect(state.grants.pendingRemoves.size).toBe(0)
  })

  test('tracks pending additions and removals for save readiness', () => {
    const grants: GrantEntry[] = [
      {
        email: 'viewer@example.com',
        grantedAt: '2026-05-22T00:00:00.000Z',
        user: null,
      },
    ]
    let state = createVisibilityDialogState('private', true)
    state = visibilityDialogReducer(state, {
      type: 'add-pending-grants',
      emails: ['new@example.com'],
    })
    state = visibilityDialogReducer(state, {
      type: 'toggle-grant-removal',
      email: 'viewer@example.com',
    })

    const view = getVisibilityDialogGrantView(
      state,
      grants,
      'owner@example.com',
    )

    expect(view.visibleEntries.map((grant) => grant.email)).toEqual([
      'viewer@example.com',
      'new@example.com',
    ])
    expect(view.activeCount).toBe(1)
    expect(hasVisibilityDialogChanges(state, view, 'private')).toBe(true)
  })

  test('restores a queued removal when the same email is added again', () => {
    let state = createVisibilityDialogState('private', true)
    state = visibilityDialogReducer(state, {
      type: 'toggle-grant-removal',
      email: 'viewer@example.com',
    })
    state = visibilityDialogReducer(state, {
      type: 'restore-grants',
      emails: ['viewer@example.com'],
    })

    expect(state.grants.pendingRemoves.has('viewer@example.com')).toBe(false)
  })

  test('counts restored removals before deciding remaining add slots', () => {
    const grants: GrantEntry[] = Array.from(
      { length: MAX_GRANT_EMAILS },
      (_, index) => ({
        email: `viewer-${index + 1}@example.com`,
        grantedAt: '2026-05-22T00:00:00.000Z',
        user: null,
      }),
    )
    let state = createVisibilityDialogState('private', true)
    state = visibilityDialogReducer(state, {
      type: 'toggle-grant-removal',
      email: 'viewer-1@example.com',
    })
    const viewBeforeRestore = getVisibilityDialogGrantView(
      state,
      grants,
      'owner@example.com',
    )
    const restoredGrantCount = ['viewer-1@example.com', 'new@example.com']
      .filter((email) => state.grants.pendingRemoves.has(email))
      .filter((email) =>
        viewBeforeRestore.initialEntries.some((grant) => grant.email === email),
      ).length

    expect(viewBeforeRestore.activeCount).toBe(MAX_GRANT_EMAILS - 1)
    expect(
      remainingGrantSlotsAfterRestore(
        viewBeforeRestore.activeCount,
        restoredGrantCount,
      ),
    ).toBe(0)
  })

  test('keeps submitted grants until revalidation while updating canonical link state', () => {
    let state = createVisibilityDialogState('private', true)
    state = visibilityDialogReducer(state, { type: 'select', value: 'link' })
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: '2026-08-20',
    })
    state = visibilityDialogReducer(state, {
      type: 'add-pending-grants',
      emails: ['viewer@example.com'],
    })

    state = visibilityDialogReducer(state, {
      type: 'save-succeeded',
      visibility: 'link',
      linkExpiryDate: '2026-08-21',
      linkExpiryUnlimited: false,
    })

    expect(state.selected).toBe('link')
    expect(state.linkExpiryDate).toBe('2026-08-21')
    expect(state.linkExpiryUnlimited).toBe(false)
    expect(state.linkExpiryTouched).toBe(false)
    expect(state.savedLinkVisible).toBe(true)
    expect(state.grants.pendingAdds).toHaveLength(1)

    state = visibilityDialogReducer(state, {
      type: 'revalidation-succeeded',
    })
    expect(state.grants.pendingAdds).toEqual([])
    expect(state.grants.pendingRemoves.size).toBe(0)

    state = visibilityDialogReducer(state, {
      type: 'sync-open',
      open: false,
      currentVisibility: 'link',
    })
    expect(state.savedLinkVisible).toBe(false)
  })

  test('preserves the draft when the dialog closes and reopens while saving', () => {
    let state = createVisibilityDialogState('link', true, {
      linkExpiryDate: '2026-08-19',
      linkExpiryUnlimited: false,
    })
    state = visibilityDialogReducer(state, {
      type: 'set-link-expiry-date',
      value: '2026-08-20',
    })
    state = visibilityDialogReducer(state, {
      type: 'set-saving',
      saving: true,
    })

    for (const open of [false, true]) {
      state = visibilityDialogReducer(state, {
        type: 'sync-open',
        open,
        currentVisibility: 'link',
        linkExpiryDate: '2026-08-19',
        linkExpiryUnlimited: false,
      })
    }

    expect(state.linkExpiryDate).toBe('2026-08-20')
    expect(state.linkExpiryTouched).toBe(true)
    expect(state.grants.saving).toBe(true)
  })
})
