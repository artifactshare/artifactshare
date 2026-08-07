import { type TextSelectionMessage } from '~/lib/csp-reporter'

export type PendingTextAnchor = Pick<
  TextSelectionMessage,
  | 'quotedText'
  | 'prefixText'
  | 'suffixText'
  | 'textStart'
  | 'textEnd'
  | 'cssPath'
  | 'rect'
>
