import type { EditableVisibility } from '~/lib/shareable-types'
import type { UserInfo } from '~/lib/user'
import { MAX_GRANT_EMAILS, parseGrantEmails } from '~/lib/grant-emails'

export interface UploadDialogState {
  dragOver: boolean
  visibility: EditableVisibility
  grantInput: string
  grantEmails: string[]
  uploading: boolean
  defaultVisibility: EditableVisibility
  open: boolean
}

export type UploadDialogAction =
  | {
      type: 'props-changed'
      defaultVisibility: EditableVisibility
      open: boolean
    }
  | { type: 'drag-over-changed'; dragOver: boolean }
  | { type: 'visibility-selected'; visibility: EditableVisibility }
  | { type: 'grant-input-changed'; value: string }
  | { type: 'grant-input-committed'; user: UserInfo }
  | { type: 'grant-email-removed'; email: string }
  | { type: 'uploading-changed'; uploading: boolean }
  | { type: 'grants-cleared' }

export function createUploadDialogState({
  defaultVisibility,
  open,
}: {
  defaultVisibility: EditableVisibility
  open: boolean
}): UploadDialogState {
  return {
    dragOver: false,
    visibility: defaultVisibility,
    grantInput: '',
    grantEmails: [],
    uploading: false,
    defaultVisibility,
    open,
  }
}

export function uploadDialogReducer(
  state: UploadDialogState,
  action: UploadDialogAction,
): UploadDialogState {
  switch (action.type) {
    case 'props-changed':
      return resolveUploadDialogState(state, action)
    case 'drag-over-changed':
      return { ...state, dragOver: action.dragOver }
    case 'visibility-selected':
      return {
        ...state,
        visibility: action.visibility,
        grantInput: action.visibility === 'private' ? state.grantInput : '',
        grantEmails: action.visibility === 'private' ? state.grantEmails : [],
      }
    case 'grant-input-changed':
      return { ...state, grantInput: action.value }
    case 'grant-input-committed': {
      const emails = inputGrantEmails(state.grantInput, action.user)
      return {
        ...state,
        grantInput: '',
        grantEmails:
          emails.length === 0
            ? state.grantEmails
            : mergeGrantEmails(state.grantEmails, emails),
      }
    }
    case 'grant-email-removed':
      return {
        ...state,
        grantEmails: state.grantEmails.filter((item) => item !== action.email),
      }
    case 'uploading-changed':
      return { ...state, uploading: action.uploading }
    case 'grants-cleared':
      return {
        ...state,
        grantInput: '',
        grantEmails: [],
      }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export function resolveUploadDialogState(
  state: UploadDialogState,
  props: {
    defaultVisibility: EditableVisibility
    open: boolean
  },
): UploadDialogState {
  const defaultChanged = state.defaultVisibility !== props.defaultVisibility
  const opened = !state.open && props.open
  if (!defaultChanged && state.open === props.open) return state
  return {
    ...state,
    defaultVisibility: props.defaultVisibility,
    open: props.open,
    visibility:
      defaultChanged || opened ? props.defaultVisibility : state.visibility,
    grantInput: opened ? '' : state.grantInput,
    grantEmails: opened ? [] : state.grantEmails,
  }
}

export function resolveGrantEmailsForUpload(
  grantEmails: ReadonlyArray<string>,
  grantInput: string,
  user: UserInfo,
): string[] {
  return mergeGrantEmails(grantEmails, inputGrantEmails(grantInput, user))
}

function mergeGrantEmails(
  current: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): string[] {
  const seen = new Set(current)
  const merged = [...current]
  for (const email of next) {
    if (merged.length >= MAX_GRANT_EMAILS) break
    if (seen.has(email)) continue
    merged.push(email)
    seen.add(email)
  }
  return merged
}

function inputGrantEmails(value: string, user: UserInfo): string[] {
  return parseGrantEmails(value, user.email)
}
