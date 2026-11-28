#!/usr/bin/env node
// Journey: the Settings pages a workspace owner and a member see, and the Plan
// and billing page in every state a user can meet. On the local stack a Team
// member sees the admin pages refused and billing read-only, the Team owner
// renames the workspace and the member sees the new name, a Free owner's
// storage usage grows after a share and a revoked API token stops the CLI.
// Stripe is not configured locally, so the subscription states (past due,
// ending, over the included storage, near the Free limit) are read from the
// dev fixture pages at /dev/settings/<state>/billing.
//
//   node .claude/skills/verify-artifactshare/scripts/journeys/settings-billing.mjs [--run <id>]
//
// Evidence: .verify-artifactshare/runs/<id>/evidence/settings-billing/
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  actUntil,
  capture,
  createApiToken,
  evidenceDir,
  openRun,
  runCli,
  signIn,
  uiText,
} from '../harness.mjs'

const FEATURE = 'settings-billing'
const runIndex = process.argv.indexOf('--run')
const run = openRun(runIndex > 0 ? process.argv[runIndex + 1] : undefined)
const stamp = Date.now()
const teamWorkspace = 'Artifact Share Local Dev Team'
const renamed = `Verify workspace ${stamp}`
const tokenName = `verify-settings-${stamp}`
const title = `Verify settings file ${stamp}`
const steps = []
const step = (name, detail) => {
  steps.push({ name, ...detail })
  console.log(`ok ${name}`)
}

const workDir = join(run.runDir, 'settings-billing-work')
mkdirSync(workDir, { recursive: true })
const file = join(workDir, 'settings-file.html')
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${'Storage usage proof. '.repeat(200)}</p></main></body></html>`,
)

const t = (key, vars) => uiText('en', key, vars)
const settingsNav = (page) =>
  page.getByRole('navigation', { name: 'Workspace settings' })
const breadcrumb = (page) => page.getByRole('navigation', { name: 'Location' })
const currentPlan = (page) => page.getByRole('region', { name: 'Current plan' })
const storageUsed = (page) =>
  page
    .getByRole('region', { name: 'Storage usage' })
    .locator('strong')
    .first()
const membersTable = (page) => page.locator('main').getByRole('table')

const browsers = []
const open = async (persona, next) => {
  const session = await signIn(run, { persona, next })
  session.page.setDefaultTimeout(20_000)
  browsers.push(session.browser)
  return session
}

try {
  // A Team member signs in first, so the owner's member list has them.
  const member = await open('Team member', '/settings')
  const mPage = member.page
  await membersTable(mPage)
    .getByRole('row', { name: /dev-team-owner@artifactshare\.local/u })
    .waitFor()
  for (const admin of ['Bots', 'Activity', 'Inventory'])
    if (await settingsNav(mPage).getByRole('link', { name: admin }).count())
      throw new Error(`a member's Settings menu offers ${admin}`)
  await capture(run, FEATURE, '01-member-settings', mPage)
  step('a member sees Members without the admin pages in the menu')

  const bots = await mPage.goto(`${run.appOrigin}/settings/bots`)
  if (bots?.status() !== 403)
    throw new Error(`a member opened /settings/bots with ${bots?.status()}`)
  await mPage
    .getByRole('heading', { name: t('settings.error.forbidden.title') })
    .waitFor()
  await capture(run, FEATURE, '02-member-bots-denied', mPage)
  step('a member who opens an admin page by URL gets Access denied (403)')

  await mPage.goto(`${run.appOrigin}/settings/billing`)
  await mPage.getByText(t('billing.readOnly.seeGeneral')).waitFor()
  if (await currentPlan(mPage).getByRole('button').count())
    throw new Error('a member is offered a billing action')
  await mPage.getByRole('link', { name: t('billing.readOnly.generalLink') }).click()
  await mPage.waitForURL(/\/settings\/general$/u)
  const memberName = mPage.getByRole('textbox', { name: 'Display name' })
  await memberName.waitFor()
  if (!(await memberName.isDisabled()))
    throw new Error('a member can edit the workspace name')
  await capture(run, FEATURE, '03-member-general', mPage)
  step('a member reads billing without actions and cannot rename the workspace')

  const owner = await open('Team owner', '/settings')
  const oPage = owner.page
  await membersTable(oPage)
    .getByRole('row', { name: /dev-team-member@artifactshare\.local/u })
    .waitFor()
  for (const admin of ['Bots', 'Activity', 'Inventory'])
    await settingsNav(oPage).getByRole('link', { name: admin }).waitFor()
  await capture(run, FEATURE, '04-owner-members', oPage)
  step('the owner sees the member in Members and the admin pages in the menu')

  await oPage.goto(`${run.appOrigin}/settings/billing`)
  await currentPlan(oPage).getByText(t('billing.plan.team')).first().waitFor()
  await currentPlan(oPage).getByText(t('billing.unavailable')).waitFor()
  await capture(run, FEATURE, '05-owner-billing-unconfigured', oPage)
  step('the Team owner billing page says billing is unavailable without Stripe')

  const rename = async (page, name) => {
    await page.goto(`${run.appOrigin}/settings/general`)
    const field = page.getByRole('textbox', { name: 'Display name' })
    await actUntil(
      page,
      async () => {
        await field.fill(name)
        await page.getByRole('button', { name: 'Save' }).click()
      },
      breadcrumb(page).getByRole('link', { name }),
    )
  }
  await rename(oPage, renamed)
  await oPage.reload()
  await breadcrumb(oPage).getByRole('link', { name: renamed }).waitFor()
  await capture(run, FEATURE, '06-owner-renamed', oPage)
  await mPage.goto(`${run.appOrigin}/settings/general`)
  await breadcrumb(mPage).getByRole('link', { name: renamed }).waitFor()
  if ((await mPage.getByRole('textbox', { name: 'Display name' }).inputValue()) !== renamed)
    throw new Error('the member does not see the new workspace name')
  await capture(run, FEATURE, '07-member-sees-rename', mPage)
  // Leave the workspace as the dev sign-in made it for the journeys after this.
  await rename(oPage, teamWorkspace)
  step('the owner renames the workspace and the member sees the new name', {
    renamed,
  })

  const free = await open('Free owner', '/settings/billing')
  const fPage = free.page
  await currentPlan(fPage).getByText(t('billing.plan.free')).first().waitFor()
  await currentPlan(fPage).getByText(t('billing.subscription.none')).waitFor()
  await currentPlan(fPage).getByText(t('billing.unavailable')).waitFor()
  const usedBefore = await storageUsed(fPage).innerText()
  await capture(run, FEATURE, '08-free-billing', fPage)
  step('a Free owner sees the Free plan, no subscription and storage usage', {
    usedBefore,
  })

  const token = await createApiToken(fPage, run, tokenName)
  const whoami = runCli(run, FEATURE, '09-cli-whoami', ['whoami', '--json'], {
    token,
  })
  if (whoami.exitCode !== 0 || !whoami.stdout.includes('@artifactshare.local'))
    throw new Error(`whoami failed: ${whoami.stdout}${whoami.stderr}`)
  const share = runCli(run, FEATURE, '10-cli-share', ['share', file, '--json'], {
    token,
    cwd: workDir,
  })
  if (share.exitCode !== 0)
    throw new Error(`share failed: ${share.stdout}${share.stderr}`)
  await fPage.goto(`${run.appOrigin}/settings/billing`)
  const usedAfter = await storageUsed(fPage).innerText()
  if (usedAfter === usedBefore)
    throw new Error(`storage used stayed at ${usedBefore} after a share`)
  await capture(run, FEATURE, '11-free-billing-after-share', fPage)
  step('a share raises the storage used on the billing page', {
    usedBefore,
    usedAfter,
  })

  await fPage.goto(`${run.appOrigin}/settings/tokens`)
  const tokenRow = fPage.getByRole('row').filter({ hasText: tokenName })
  const revokeDialog = fPage.getByRole('alertdialog', {
    name: t('team.tokens.revoke.title', { name: tokenName }),
  })
  await actUntil(
    fPage,
    () =>
      tokenRow.getByRole('button', { name: t('team.tokens.revoke') }).click(),
    revokeDialog,
  )
  await capture(run, FEATURE, '12-revoke-dialog', fPage, revokeDialog)
  await revokeDialog
    .getByRole('button', { name: t('team.tokens.revoke') })
    .click()
  await revokeDialog.waitFor({ state: 'hidden' })
  await fPage.reload()
  await fPage.getByRole('heading', { name: 'AI tools and CLI' }).first().waitFor()
  if (await tokenRow.count())
    throw new Error('the revoked token is still listed')
  await capture(run, FEATURE, '13-tokens-after-revoke', fPage)
  const refused = runCli(
    run,
    FEATURE,
    '14-cli-whoami-revoked',
    ['whoami', '--json'],
    { token },
  )
  if (refused.exitCode === 0 || refused.json?.error?.code !== 'token_invalid')
    throw new Error(`a revoked token was not refused: ${refused.stdout}${refused.stderr}`)
  step('a revoked token leaves the list and the CLI gets token_invalid')

  // Stripe states: the local stack has no Stripe, so read them from fixtures.
  // The bill estimate formats its dates in the viewer's locale after
  // hydration and shows a dash until then, so capture the hydrated page.
  const fixture = async (page, state, name) => {
    await page.goto(`${run.appOrigin}/dev/settings/${state}/billing`)
    await currentPlan(page).waitFor()
    await page.waitForLoadState('networkidle')
    await capture(run, FEATURE, name, page)
  }
  const unpaidNote = (locale) =>
    uiText(locale, 'billing.estimate.planUnpaid', { date: '\u0000' }).split('\u0000')
  await fixture(fPage, 'team-past-due', '15-fixture-past-due')
  await fPage
    .getByRole('alert')
    .filter({ hasText: t('billing.pastDue.banner') })
    .waitFor()
  await currentPlan(fPage).getByText(t('billing.subscription.pastDue')).waitFor()
  await fPage
    .getByRole('button', { name: t('billing.portal') })
    .waitFor()
  await fPage.getByText(new RegExp(`${unpaidNote('en')[0]}\\d`, 'u')).waitFor()
  step('fixture: a failed payment shows the urgent banner and Past due')

  await fixture(fPage, 'team-cancel-scheduled', '16-fixture-cancel-scheduled')
  await currentPlan(fPage).getByText(t('billing.contract.endsAt'), { exact: false }).waitFor()
  step('fixture: a cancelled contract shows when it ends')

  await fixture(fPage, 'team-overage', '17-fixture-overage')
  const overage = await fPage.locator('main').innerText()
  if (!overage.includes('112%') || !overage.includes('12 GB'))
    throw new Error('the overage fixture does not show 112% and 12 GB of overage')
  step('fixture: storage past the included amount shows the projected overage')

  await fixture(fPage, 'free-near-limit', '18-fixture-free-near-limit')
  await fPage
    .getByRole('alert')
    .filter({ hasText: t('team.usage.nearLimit') })
    .getByText(t('team.usage.nearLimitAdmin'))
    .waitFor()
  for (const plan of ['Choose Plus', 'Choose Team'])
    await currentPlan(fPage).getByRole('button', { name: plan }).waitFor()
  step('fixture: a Free owner near the limit is told to choose a plan here')

  await fixture(fPage, 'team-member', '19-fixture-team-member')
  await fPage.getByText(t('billing.readOnly.seeGeneral')).waitFor()
  if (await currentPlan(fPage).getByRole('button').count())
    throw new Error('the member fixture offers a billing action')
  step('fixture: a member of a subscribed team gets no billing action')

  const ja = await free.browser.newContext({
    storageState: await free.context.storageState(),
    ignoreHTTPSErrors: true,
    locale: 'ja',
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  })
  const jaPage = await ja.newPage()
  await jaPage.goto(`${run.appOrigin}/dev/settings/team-past-due/billing`)
  await jaPage
    .getByRole('alert')
    .filter({ hasText: uiText('ja', 'billing.pastDue.banner') })
    .waitFor()
  await jaPage.waitForLoadState('networkidle')
  await jaPage
    .getByText(new RegExp(`\\d${unpaidNote('ja')[1]}`, 'u'))
    .waitFor()
  await capture(run, FEATURE, '20-fixture-past-due-ja-phone', jaPage)
  await ja.close()
  step('fixture: a Japanese phone sees the past-due banner in Japanese')
} finally {
  await Promise.all(browsers.map((browser) => browser.close()))
  writeFileSync(
    join(evidenceDir(run, FEATURE), 'steps.json'),
    `${JSON.stringify({ run: run.id, renamed, tokenName, title, steps }, null, 2)}\n`,
  )
}
console.log(`PASS ${FEATURE}: evidence in ${evidenceDir(run, FEATURE)}`)
