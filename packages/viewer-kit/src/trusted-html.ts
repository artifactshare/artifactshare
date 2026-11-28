declare const trustedHtmlBrand: unique symbol

// HTML this package's markdown renderer produced. `renderMarkdownBody` is its
// only producer, so a value that reaches an innerHTML sink as TrustedHtml came
// from the renderer and not from a request, a document, or a comment.
export type TrustedHtml = string & { readonly [trustedHtmlBrand]: true }

// Both halves of a rendered document are still rendered output.
export function sliceTrustedHtml(
  html: TrustedHtml,
  start: number,
  end?: number,
): TrustedHtml {
  return html.slice(start, end) as TrustedHtml
}
