import {
  type GrantEditorState,
  type GrantEditorView,
  createGrantEditorState,
  getGrantEditorView,
  grantEditorReducer,
  hasGrantEditorChanges,
} from '~/components/app/grant-editor-state'
import type { EditableVisibility, Visibility } from '~/lib/shareable-types'
import type { GrantEntry } from '~/services/shareables.server'

export interface VisibilityDialogState {
  selected: EditableVisibility
  linkExpiryDate: string | null
  linkExpiryUnlimited: boolean
  linkExpiryTouched: boolean
  grants: GrantEditorState
  prevOpen: boolean
}

export type VisibilityDialogAction =
  | {
      type: 'sync-open'
      open: boolean
      currentVisibility: EditableVisibility
      linkExpiryDate?: string | null
      linkExpiryUnlimited?: boolean
    }
  | { type: 'select'; value: EditableVisibility }
  | { type: 'set-link-expiry-date'; value: string }
  | { type: 'set-link-expiry-unlimited'; value: boolean }
  | { type: 'set-grant-input'; value: string }
  | { type: 'clear-grant-input' }
  | { type: 'restore-grants'; emails: ReadonlyArray<string> }
  | { type: 'add-pending-grants'; emails: ReadonlyArray<string> }
  | {
      type: 'resolve-pending-grants'
      entries: ReadonlyArray<{ email: string; user: GrantEntry['user'] }>
    }
  | { type: 'toggle-grant-removal'; email: string }
  | { type: 'remove-pending-grant'; email: string }
  | { type: 'set-saving'; saving: boolean }

export type VisibilityDialogGrantView = GrantEditorView

export function createVisibilityDialogState(
  currentVisibility: EditableVisibility,
  open: boolean,
  options: {
    linkExpiryDate?: string | null
    linkExpiryUnlimited?: boolean
  } = {},
): VisibilityDialogState {
  return {
    selected: currentVisibility,
    linkExpiryDate: options.linkExpiryDate ?? null,
    linkExpiryUnlimited: options.linkExpiryUnlimited ?? false,
    linkExpiryTouched: false,
    grants: createGrantEditorState(open),
    prevOpen: open,
  }
}

export function visibilityDialogReducer(
  state: VisibilityDialogState,
  action: VisibilityDialogAction,
): VisibilityDialogState {
  switch (action.type) {
    case 'sync-open':
      if (state.prevOpen === action.open) return state
      if (!action.open) {
        return {
          ...state,
          grants: grantEditorReducer(state.grants, {
            type: 'sync-open',
            open: action.open,
          }),
          prevOpen: action.open,
        }
      }
      return {
        ...createVisibilityDialogState(action.currentVisibility, action.open, {
          linkExpiryDate: action.linkExpiryDate,
          linkExpiryUnlimited: action.linkExpiryUnlimited,
        }),
        grants: {
          ...createGrantEditorState(action.open),
          saving: state.grants.saving,
        },
      }
    case 'select':
      return { ...state, selected: action.value }
    case 'set-link-expiry-date':
      return {
        ...state,
        linkExpiryDate: action.value,
        linkExpiryUnlimited: false,
        linkExpiryTouched: true,
      }
    case 'set-link-expiry-unlimited':
      return {
        ...state,
        linkExpiryUnlimited: action.value,
        linkExpiryTouched: true,
      }
    case 'set-grant-input':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'set-input',
          value: action.value,
        }),
      }
    case 'clear-grant-input':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, { type: 'clear-input' }),
      }
    case 'restore-grants':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'restore-entries',
          emails: action.emails,
        }),
      }
    case 'add-pending-grants':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'add-pending-entries',
          emails: action.emails,
        }),
      }
    case 'resolve-pending-grants':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'resolve-pending-entries',
          entries: action.entries,
        }),
      }
    case 'toggle-grant-removal':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'toggle-entry-removal',
          email: action.email,
        }),
      }
    case 'remove-pending-grant':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'remove-pending-entry',
          email: action.email,
        }),
      }
    case 'set-saving':
      return {
        ...state,
        grants: grantEditorReducer(state.grants, {
          type: 'set-saving',
          saving: action.saving,
        }),
      }
  }
}

export function getVisibilityDialogGrantView(
  state: VisibilityDialogState,
  grants: ReadonlyArray<GrantEntry>,
  ownerEmail: string | null,
): VisibilityDialogGrantView {
  return getGrantEditorView(state.grants, grants, ownerEmail)
}

export function hasVisibilityDialogChanges(
  state: VisibilityDialogState,
  grantView: VisibilityDialogGrantView,
  currentVisibility: Visibility,
  linkExpiryChanged = false,
): boolean {
  return (
    hasGrantEditorChanges(state.grants, grantView) ||
    state.selected !== currentVisibility ||
    linkExpiryChanged
  )
}
