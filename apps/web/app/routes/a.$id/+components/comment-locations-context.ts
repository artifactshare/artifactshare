import { createContext } from 'react'

// 静的サイトでは、文章コメントがどのページのものかをカードに示し、全体への
// composer を「サイト全体」と呼ぶ。ビューアが値を渡し、コメントパネルが読む。
export const CommentLocationsContext = createContext(false)
