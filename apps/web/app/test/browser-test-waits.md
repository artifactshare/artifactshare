# Browser test waits

A required wait must reject when its condition never arrives. Await the native
wait directly, or use `requiredWait` from `apps/web/app/test/browser-waits.ts`
with a static phase description. The wrapper deliberately omits the underlying
error text because browser errors can contain signed URLs. It adds no retry or
new timeout; set the native wait's timeout for the work being observed.

```ts
await requiredWait(
  'viewer iframe ready',
  page.locator('[data-sandbox-state="ready"]').waitFor({ timeout: 10000 }),
)
const popup = await openPopup(context, () => action.click())
```

`openPopup` registers the page waiter before running the trigger, observes both
rejections, and aborts and drains the waiter on exit. The installed Playwright
supports `AbortSignal` on this wait. It does not cancel the trigger operation;
its rejection remains observed, and the calling fixture still owns its browser
context and pages. Keep popup actions serial within that context. Popup events,
usercontent fixture reports, and viewer-ready navigation retain their original
30-second Playwright budgets explicitly; other waits keep their own budgets.

Use `browser-layout.ts` for ordinary React commit/layout boundaries and
`wait-for-real-task-condition.ts` for native async work under fake timers. Neither
proves an arbitrary future operation completed. Wait for the specific state,
focus target, or finite animation to finish before reading the result. Preserve
cross-origin fixture checks of origin, source window, and load nonce; a frame
existing is not proof that the intended document is ready.

Capability observations are different from required readiness. A video engine
may not finish seeking or apply volume without an audio device. Catch only the
expected timeout, return an explicit result, and check both supported and
unsupported observations in the test. A closed page or unexpected error is not
an unsupported capability. Fullscreen waits should observe the applicable
player, native-video, or unavailable-notice outcome. Optional cleanup may ignore
an already-released resource; it must never be used to turn required readiness
into success.

Do not replace a negative time assertion with an immediately true condition.
For example, hidden thumbnails must stay undrawn during the observation window,
and cleared searches must not acquire late results. Keep the real interval and
its assertion, and explain the contract immediately before a Playwright sleep:

```ts
// test-wait: elapsed-time — clearing a query must prevent late result counts.
await frame.waitForTimeout(1000)
expect(await results()).toBe('')
```

The root Oxlint `test-reliability/observed-waits` rule checks tests and test helper
directories for empty/undefined/null/false and logging-only rejection handlers on
`waitFor*`, `requiredWait`, and `toX` assertion calls. This includes inline
`catch` and the second callback of `then`, through direct `then`/`catch`/`finally`
chains. Logging means direct `console.log/warn/error/info/debug` calls, optionally
followed by a discarded return. It also checks optional `click`, `focus`, and
`dispatchEvent` interactions and `waitForTimeout` without that explanation. Require the target before acting:
`button!.click()` throws if it is missing, while `button?.click()` skips the test
operation. Prefer an explicit existence assertion or observed readiness when
mounting is asynchronous.

The rule is intentionally syntactic. It does not follow aliases or promise
variables, validate the meaning of capability results or comments, inspect
arbitrary catch bodies, or classify native timers. In particular, named callbacks,
aliased logging,
conditional/assignment/helper-call catch bodies, nonliteral false-like values,
and promise combinators are outside this rule. A branch that rethrows unexpected
errors is deliberately not classified as silent. Native timers also implement
fixture latency, task yielding, deadlines, and negative time contracts; inspect
the caller before changing them. Explicit capability and cleanup paths are not
blanket file exemptions. Real bad/good fixtures run through the configured
Oxlint command in `scripts/test-reliability-lint-plugin.test.mjs`.

Repeated assertions may reuse the immutable result of a completed scenario
within one test file and engine. The scenario must close its context first;
never share a live page or cache across engines. Keep failure promises visible
so another assertion cannot rerun a failed scenario until it passes.

Targeted checks:

```sh
node --test scripts/browser-waits.test.mjs scripts/test-reliability-lint-plugin.test.mjs
node --test scripts/browser-waits.integration.mjs
pnpm --filter @artifactshare/web exec vitest --config vitest.behavior.browser.config.ts --run app/lib/pdf-viewer.behavior.browser.test.tsx app/lib/video-viewer.behavior.browser.test.tsx --project chromium
```

The integration check requires an installed Chromium and exercises a real wrong
completion condition, normal readiness, popup success, and native listener
release after trigger failure, using the public context event-listener API.
Public CI runs this exact check in the existing merge-queue Chromium
`browser-validation` lane after browser installation, for every merge including
helper and dependency changes. Failure or missing browser installation fails the
lane; skipped/cancelled/missing lanes cannot satisfy full validation. Selective
PR lanes do not run this check. The static lane runs only the browser-free script
unit tests, which also force both rejection orders. Full static and cross-platform
validation remain separate checks.

Examples of choosing the observation and fault control:

- Directory selection: compare the exact selected file set in
  [upload-boundary tests](../../../../packages/cli/src/upload-boundary.test.ts).
  Accidentally including `.env` or dropping `dist` must change that set. A CLI
  upload failing with no filename in stderr does not establish selection.
- Required PDF readiness: observe the current page/result before reading its
  state. The native integration check above uses a real missing completion
  condition and a healthy control; an import or browser-start failure is not
  evidence that the intended assertion detects a fault.
- A deep-link verdict before readiness: the
  [static-site anchor regression](../lib/static-site-comment-anchors.behavior.browser.test.tsx)
  holds the real ready checks until the early verdict has been observed, then
  releases the real handshake and checks that the verdict is delivered again.
  This exercises the problematic order deliberately. Repetition alone cannot
  prove that order was reached, and the product must retain origin/token checks.
