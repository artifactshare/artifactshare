import { type TextSelectionMessage } from '~/lib/csp-reporter'

export type PendingTextAnchor = Pick<
  TextSelectionMessage,
  | 'locus'
  | 'quotedText'
  | 'prefixText'
  | 'suffixText'
  | 'textStart'
  | 'textEnd'
  | 'cssPath'
  | 'rect'
  | 'selectorFormat'
  | 'textHash'
  | 'ambiguousAtCreation'
  | 'versionId'
>
