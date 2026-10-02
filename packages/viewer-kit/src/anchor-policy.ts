/** Source policy shared by the inert parser and the injected DOM reporter. */
export const ANCHOR_EXCLUDED_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
]
export const ANCHOR_EXCLUDED_ATTRIBUTES = ['data-comment-ui', 'data-code-copy']
export const ANCHOR_EXCLUDED_CLASSES = [
  'ash-comment-highlight-badge',
  'ash-comment-highlight-svg',
  'code-copy-button',
  'md-code-toolbar',
]
export const ANCHOR_EXCLUDED_SELECTOR = [
  ...ANCHOR_EXCLUDED_TAGS,
  ...ANCHOR_EXCLUDED_ATTRIBUTES.map((name) => `[${name}]`),
  ...ANCHOR_EXCLUDED_CLASSES.map((name) => `.${name}`),
].join(',')
