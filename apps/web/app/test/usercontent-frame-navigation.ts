import { createHash } from 'node:crypto'
import type { Page } from 'playwright'

export interface FixtureState {
  nonce: string
  heading: string | null
  pathname: string
  hash: string
  asset: string | null
  style: string
  cookieAttack: string | null
  commandId?: string
  status?: number
}
type Report = { origin: string; state: FixtureState }
declare global {
  interface Window {
    usercontentReports: Report[]
  }
}

// Runs before parser-created frames can send their first report. Validate both
// the exact origin and the WindowProxy without consulting automation frames.
export function collectUsercontentReports() {
  window.usercontentReports = []
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'usercontent-fixture-state') return
    const frame = document.querySelector<HTMLIFrameElement>('iframe')
    if (!frame || event.source !== frame.contentWindow) return
    const expected = new URL(frame.dataset.src || frame.src, location.href)
    if (event.origin !== expected.origin) return
    window.usercontentReports.push({
      origin: event.origin,
      state: event.data.state,
    })
  })
}

// Uploaded fixture content only: observes actual DOM/assets and executes a
// closed set of interactions. No product reporter or delivery code is changed.
export function reportUsercontentState(parentOrigin: string) {
  if (parentOrigin === 'link')
    parentOrigin = `https://${location.hostname.split('--v-')[0].slice(2)}.link.example`
  const nonce = crypto.randomUUID()
  const report = (commandId?: string, status?: number) => {
    parent.postMessage(
      {
        type: 'usercontent-fixture-state',
        state: {
          nonce,
          heading: document.querySelector('h1')?.textContent ?? null,
          pathname: location.pathname,
          hash: location.hash,
          asset: document.body.getAttribute('data-asset'),
          style: getComputedStyle(document.body)
            .getPropertyValue('--delivery-asset')
            .trim(),
          cookieAttack: document.body.getAttribute('data-cookie-attack'),
          commandId,
          status,
        },
      },
      parentOrigin,
    )
  }
  window.addEventListener('load', () => report())
  window.addEventListener('hashchange', () => report())
  window.addEventListener('message', async (event) => {
    if (
      event.origin !== parentOrigin ||
      event.source !== parent ||
      event.data?.type !== 'usercontent-fixture-command' ||
      event.data.nonce !== nonce
    )
      return
    const { command, id } = event.data
    if (command === 'hash') location.hash = '#changed'
    else if (command === 'next')
      document.querySelector<HTMLAnchorElement>('a[href="next.html"]')!.click()
    else if (command === 'download')
      document
        .querySelector<HTMLAnchorElement>('a[download="fixture.txt"]')!
        .click()
    else if (command === 'asset-status') {
      report(id, (await fetch('/style.css')).status)
      return
    } else return
    report(id)
  })
}

export function usercontentFixtureScript(parentOrigin: string) {
  return `<script>(${reportUsercontentState.toString()})(${JSON.stringify(parentOrigin)})</script>`
}

export async function waitForUsercontentState(
  page: Page,
  origin: string,
  match: Partial<FixtureState>,
  afterNonce?: string,
): Promise<FixtureState> {
  const handle = await page.waitForFunction(
    (expected) =>
      window.usercontentReports.findLast(
        (report) =>
          report.origin === expected.origin &&
          report.state.nonce !== expected.afterNonce &&
          Object.entries(expected.match).every(
            ([key, value]) => report.state[key as keyof FixtureState] === value,
          ),
      )?.state,
    { origin, match, afterNonce },
  )
  const state = await handle.jsonValue()
  if (!state) throw new Error('Missing fixture state after wait')
  return state
}

export async function commandUsercontentFixture(
  page: Page,
  origin: string,
  state: FixtureState,
  command: 'hash' | 'next' | 'download' | 'asset-status',
) {
  const id = crypto.randomUUID()
  await page.evaluate(
    (request) => {
      document
        .querySelector<HTMLIFrameElement>('iframe[data-src]')!
        .contentWindow!.postMessage(
          {
            type: 'usercontent-fixture-command',
            nonce: request.nonce,
            command: request.command,
            id: request.id,
          },
          request.origin,
        )
    },
    { origin, nonce: state.nonce, command, id },
  )
  return waitForUsercontentState(page, origin, { commandId: id })
}

export function usercontentFrameEvidence(page: Page) {
  return page
    .evaluate(() => ({
      sandboxStates: Array.from(
        document.querySelectorAll('[data-sandbox-state]'),
        (element) => element.getAttribute('data-sandbox-state'),
      ),
      executionUrls: Array.from(
        document.querySelectorAll<HTMLIFrameElement>('iframe[data-src]'),
        (frame) => frame.src.split('?')[0],
      ),
      reports: window.usercontentReports ?? [],
    }))
    .catch(() => ({
      sandboxStates: ['(unavailable)'],
      executionUrls: [],
      reports: [],
    }))
}

export async function navigateUsercontentViewer(
  page: Page,
  navigate: () => Promise<unknown>,
) {
  await navigate()
  await page.locator('[data-sandbox-state="ready"]').waitFor()
}

// The Markdown renderer strips raw scripts and permits only hashed reporters.
// The local proxy adds this exact observer hash, leaving every other directive
// intact. Never broaden script-src to unsafe-inline for the Markdown fixture.
export function instrumentMarkdownFixture(
  body: string,
  policy: string,
  script: string,
) {
  const source = script.slice('<script>'.length, -'</script>'.length)
  const hash = createHash('sha256').update(source).digest('base64')
  return {
    body: body.replace('</body>', `${script}</body>`),
    policy: policy.replace('script-src ', `script-src 'sha256-${hash}' `),
  }
}
