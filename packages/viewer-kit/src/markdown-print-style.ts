// Dependency-free presentation shared by the renderer and PDF preparation.
export const MD_LIGHT_STYLE = `
:root {
  color-scheme: light dark;
  --md-text: #37352f;
  --md-muted: rgba(55, 53, 47, 0.78);
  --md-faint: rgba(55, 53, 47, 0.72);
  --md-border: rgba(55, 53, 47, 0.12);
  --md-border-strong: rgba(55, 53, 47, 0.18);
  --md-bg: #fbfaf8;
  --md-surface: #ffffff;
  --md-muted-bg: #f7f6f3;
  --md-accent-bg: rgba(55, 53, 47, 0.04);
  --md-link-soft: rgba(35, 131, 226, 0.1);
  --md-code-bg: #f7f6f3;
  --md-code-block-bg: #0d1117;
  --md-code-block-surface: #161b22;
  --md-code-block-text: #f0f6fc;
  --md-code-block-muted: #9da7b3;
  --md-code-block-border: rgba(240, 246, 252, 0.14);
  --md-link: #116bb1;
  --md-link-hover: #125892;
  --md-radius-sm: 3px;
  --md-radius-md: 6px;
  --md-shadow-sm: rgba(15, 15, 15, 0.04) 0 0 0 1px, rgba(15, 15, 15, 0.04) 0 1px 2px;
}
`

// Applied only to prepared PDF content, before layout and measurement.
export const MARKDOWN_PRINT_STYLE = `${MD_LIGHT_STYLE}
:root { color-scheme: light; --md-code-block-bg: #fff; --md-code-block-surface: #f7f6f3; --md-code-block-text: #37352f; --md-code-block-muted: #37352f; }
/* Light print palette keeps syntax distinctions without relying on backgrounds. */
:root {
  --th-background: #fff; --th-token: #24292f;
  --th-attr: #0550ae; --th-code-inline: #953800; --th-command: #8250df;
  --th-comment: #57606a; --th-deleted: #cf222e; --th-function: #8250df;
  --th-heading: #0550ae; --th-inserted: #1a7f37; --th-keyword: #cf222e;
  --th-link: #0969da; --th-literal: #0550ae; --th-meta: #57606a;
  --th-number: #0550ae; --th-operator: #8250df; --th-property: #0550ae;
  --th-selector: #116329; --th-string: #0a7f64; --th-tag: #116329;
  --th-type: #953800; --th-variable: #953800;
}
.md pre code { color: #37352f; background: transparent; }
`
