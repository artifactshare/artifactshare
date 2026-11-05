/** Only pass destinations constructed from trusted host configuration. */
export function bodyRecoveryHtml(viewerUrl: string, expired = false): string {
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Return to the viewer</title><body><main><h1>Open the body again from the viewer</h1><p>${expired ? 'This opening link has expired or has already been used.' : 'This body is unavailable or you no longer have access.'} Return to the viewer, reload it, and open the body again.</p><p><a href="${escape(viewerUrl)}">Return to the viewer</a></p><section lang="ja"><h2>ビューアーから本文を開き直してください</h2><p>${expired ? 'このリンクは有効期限が切れているか、すでに使用されています。' : '本文を表示できないか、閲覧権限がなくなっています。'} ビューアーに戻って再読み込みし、本文を開き直してください。</p><p><a href="${escape(viewerUrl)}">ビューアーに戻る</a></p></section></main></body></html>`
}
