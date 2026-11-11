/** Temporary migration assignment; no targeting or provider details cross SSR. */
export type CommentSyncAssignment = Readonly<{
  mode: 'legacy' | 'session'
  build: string
}>
export const legacyCommentSync: CommentSyncAssignment = {
  mode: 'legacy',
  build: 'unknown',
}
