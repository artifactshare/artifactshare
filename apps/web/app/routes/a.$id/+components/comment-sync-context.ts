import { createContext } from 'react'
import { legacyCommentSync } from '~/lib/comment-sync'
/** Value comes from the selected owner, never directly from revalidated props. */
export const CommentSyncContext = createContext(legacyCommentSync)
