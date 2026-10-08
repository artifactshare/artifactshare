// Shared by screen seeding and real-browser CSP regression tests.
// HTML permits eval; use an inline-script fetch to exercise a real policy block.
export const CSP_DIAGNOSTIC_BODIES = [
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Script diagnostic</title></head><body><main><h1>Script diagnostic</h1><p>This file attempts a connection blocked by the security policy.</p></main><script>fetch('https://example.com/csp-diagnostic').catch(() => {})</script></body></html>`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Environment diagnostic</title></head><body><main><h1>Environment diagnostic</h1><p>This file demonstrates a browser environment diagnostic.</p></main><script>document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', { documentURI: document.URL, violatedDirective: 'script-src', originalPolicy: '', statusCode: 200, effectiveDirective: 'script-src', blockedURI: 'eval', sourceFile: '', lineNumber: 0, sample: 'environment diagnostic example', disposition: 'enforce', bubbles: true }))</script></body></html>`,
] as const
