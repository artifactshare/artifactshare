import { MAX_GRANT_EMAILS, normalizeGrantEmail } from '~/lib/grant-emails'

export interface GrantEditorUser {
  id: string
  name: string | null
  image: string | null
}

export interface GrantEditorEntry {
  email: string
  user: GrantEditorUser | null
}

export interface GrantEditorState {
  pendingAdds: GrantEditorEntry[]
  pendingRemoves: Set<string>
  input: string
  saving: boolean
  prevOpen: boolean
}

export type GrantEditorAction =
  | { type: 'sync-open'; open: boolean }
  | { type: 'set-input'; value: string }
  | { type: 'clear-input' }
  | { type: 'restore-entries'; emails: ReadonlyArray<string> }
  | { type: 'add-pending-entries'; emails: ReadonlyArray<string> }
  | {
      type: 'resolve-pending-entries'
      entries: ReadonlyArray<{ email: string; user: GrantEditorUser | null }>
    }
  | { type: 'toggle-entry-removal'; email: string }
  | { type: 'remove-pending-entry'; email: string }
  | { type: 'set-saving'; saving: boolean }

export interface GrantEditorView {
  initialEntries: ReadonlyArray<GrantEditorEntry>
  pendingAddEntries: GrantEditorEntry[]
  visibleEntries: ReadonlyArray<GrantEditorEntry>
  pendingAddEmails: string[]
  activeCount: number
  limitReached: boolean
}

export function createGrantEditorState(open: boolean): GrantEditorState {
  return {
    pendingAdds: [],
    pendingRemoves: new Set(),
    input: '',
    saving: false,
    prevOpen: open,
  }
}

export function grantEditorReducer(
  state: GrantEditorState,
  action: GrantEditorAction,
): GrantEditorState {
  switch (action.type) {
    case 'sync-open':
      if (state.prevOpen === action.open) return state
      if (!action.open) return { ...state, prevOpen: action.open }
      return { ...createGrantEditorState(action.open), saving: state.saving }
    case 'set-input':
      return { ...state, input: action.value }
    case 'clear-input':
      return { ...state, input: '' }
    case 'restore-entries': {
      if (action.emails.every((email) => !state.pendingRemoves.has(email))) {
        return state
      }
      const pendingRemoves = new Set(state.pendingRemoves)
      for (const email of action.emails) pendingRemoves.delete(email)
      return { ...state, pendingRemoves }
    }
    case 'add-pending-entries': {
      const seen = new Set(state.pendingAdds.map((entry) => entry.email))
      const pendingAdds = [...state.pendingAdds]
      for (const email of action.emails) {
        if (seen.has(email)) continue
        pendingAdds.push({ email, user: null })
        seen.add(email)
      }
      if (pendingAdds.length === state.pendingAdds.length) return state
      return { ...state, pendingAdds }
    }
    case 'resolve-pending-entries': {
      const byEmail = new Map<string, GrantEditorUser | null>()
      for (const entry of action.entries) byEmail.set(entry.email, entry.user)
      return {
        ...state,
        pendingAdds: state.pendingAdds.map((entry) =>
          byEmail.has(entry.email)
            ? { ...entry, user: byEmail.get(entry.email) ?? null }
            : entry,
        ),
      }
    }
    case 'toggle-entry-removal': {
      const pendingRemoves = new Set(state.pendingRemoves)
      if (pendingRemoves.has(action.email)) pendingRemoves.delete(action.email)
      else pendingRemoves.add(action.email)
      return { ...state, pendingRemoves }
    }
    case 'remove-pending-entry':
      return {
        ...state,
        pendingAdds: state.pendingAdds.filter(
          (entry) => entry.email !== action.email,
        ),
      }
    case 'set-saving':
      return { ...state, saving: action.saving }
  }
}

export function getGrantEditorView(
  state: GrantEditorState,
  entries: ReadonlyArray<GrantEditorEntry>,
  excludeEmail?: string | null,
): GrantEditorView {
  const initialEntries = filterGrantEditorEntries(entries, excludeEmail)
  const initialEmails = new Set(initialEntries.map((entry) => entry.email))
  const pendingAddEntries = state.pendingAdds.filter(
    (entry) => !initialEmails.has(entry.email),
  )
  const visibleEntries = [...initialEntries, ...pendingAddEntries]
  const pendingAddEmails = state.pendingAdds.map((entry) => entry.email)
  let activeCount = pendingAddEntries.length
  for (const entry of initialEntries) {
    if (!state.pendingRemoves.has(entry.email)) activeCount += 1
  }
  return {
    initialEntries,
    pendingAddEntries,
    visibleEntries,
    pendingAddEmails,
    activeCount,
    limitReached: activeCount >= MAX_GRANT_EMAILS,
  }
}

export function hasGrantEditorChanges(
  state: GrantEditorState,
  view: GrantEditorView,
): boolean {
  return view.pendingAddEntries.length > 0 || state.pendingRemoves.size > 0
}

export function filterGrantEditorEntries(
  entries: ReadonlyArray<GrantEditorEntry>,
  excludeEmail?: string | null,
): ReadonlyArray<GrantEditorEntry> {
  const normalizedExcludeEmail = normalizeGrantEmail(excludeEmail)
  if (!normalizedExcludeEmail) return entries
  return entries.filter(
    (entry) => normalizeGrantEmail(entry.email) !== normalizedExcludeEmail,
  )
}

export function countRestoredEntries(
  emails: ReadonlyArray<string>,
  pendingRemoves: ReadonlySet<string>,
  initialEntries: ReadonlyArray<GrantEditorEntry>,
): number {
  let count = 0
  for (const email of emails) {
    if (
      pendingRemoves.has(email) &&
      initialEntries.some((entry) => entry.email === email)
    ) {
      count++
    }
  }
  return count
}

export function remainingGrantSlotsAfterRestore(
  activeCount: number,
  restoredCount: number,
): number {
  return Math.max(0, MAX_GRANT_EMAILS - (activeCount + restoredCount))
}

export type GrantEditorRowStatus = 'pending-add' | 'pending-remove'

export function deriveGrantRowStatus(
  email: string,
  pendingAddEmails: ReadonlyArray<string>,
  pendingRemoves: ReadonlySet<string>,
): GrantEditorRowStatus | undefined {
  if (pendingAddEmails.includes(email)) return 'pending-add'
  if (pendingRemoves.has(email)) return 'pending-remove'
  return undefined
}
