import { Link, redirect } from 'react-router'
import type { Route } from './+types/dev.sign-in'
import { AuthCard, AuthFormStack } from '~/components/app/auth-card'
import { DevSignInOption } from '~/components/app/dev-sign-in-option'
import { Stack } from '~/components/layout/stack'
import { isViteDev } from '~/lib/is-vite-dev'
import { safeInternalNext } from '~/lib/safe-next'
import { authHandlerWithHangDetection } from '~/services/auth.server'
import {
  HEADER_DEPENDENT_SCREEN_SCENARIOS,
  isScreenScenario,
} from '~/services/dev-screen-state.server'
import { IconShield, IconUser } from '@tabler/icons-react'
import scenarioIds from '../../../../scripts/screen-scenarios.json'

const DEFAULT_NEXT = '/settings/general'

function safeDevSignInTarget(next: unknown): string {
  const path = safeInternalNext(next)
  return path === '/' ? DEFAULT_NEXT : path
}

function appendSetCookies(from: Response, headers: Headers): void {
  for (const value of from.headers.getSetCookie()) {
    headers.append('Set-Cookie', value)
  }
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name)
  if (value) to.set(name, value)
}

export function loader({ request }: Route.LoaderArgs) {
  if (!isViteDev()) throw new Response(null, { status: 404 })
  const url = new URL(request.url)
  const scenario = url.searchParams.get('scenario')
  return {
    next: safeDevSignInTarget(url.searchParams.get('next')),
    scenario: isScreenScenario(scenario) ? scenario : null,
    scenarios: scenarioIds.filter(
      (id) => !HEADER_DEPENDENT_SCREEN_SCENARIOS.includes(id),
    ),
  }
}

export async function action({ request }: Route.ActionArgs) {
  if (!isViteDev()) throw new Response(null, { status: 404 })
  const form = await request.formData()
  const persona = form.get('persona')?.toString()
  const validPersonas = [
    'free-owner',
    'plus-owner',
    'team-owner',
    'team-member',
  ] as const
  if (!validPersonas.includes(persona as (typeof validPersonas)[number])) {
    throw new Response('Bad request', { status: 400 })
  }
  const safeNext = safeDevSignInTarget(form.get('next'))
  const scenarioValue = form.get('scenario')?.toString()
  const scenario = isScreenScenario(scenarioValue) ? scenarioValue : undefined
  const headers = new Headers()
  copyHeader(request.headers, headers, 'user-agent')
  copyHeader(request.headers, headers, 'sec-fetch-site')
  copyHeader(request.headers, headers, 'sec-fetch-mode')
  copyHeader(request.headers, headers, 'sec-fetch-dest')
  copyHeader(request.headers, headers, 'sec-fetch-user')
  headers.set('content-type', 'application/json')
  headers.set('origin', new URL(request.url).origin)

  const authResponse = await authHandlerWithHangDetection(
    new Request(new URL('/api/auth/dev/sign-in', request.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ persona, ...(scenario ? { scenario } : {}) }),
    }),
  )

  if (!authResponse.ok) {
    throw new Response('Sign-in failed', { status: authResponse.status })
  }

  const redirectHeaders = new Headers()
  appendSetCookies(authResponse, redirectHeaders)
  return redirect(safeNext, { headers: redirectHeaders })
}

export default function DevSignIn({ loaderData }: Route.ComponentProps) {
  const { next, scenario, scenarios } = loaderData

  return (
    <AuthCard
      title="Local dev sign-in"
      sub="Fixed dev users for this workspace. Unavailable outside Vite dev."
    >
      <AuthFormStack aria-label="Dev users">
        <Stack gap="2" className="text-left">
          <p className="text-foreground m-0 text-sm font-semibold">
            Representative state
          </p>
          <Stack gap="1" className="text-xs">
            <Link
              to={`/dev/sign-in?next=${encodeURIComponent(next)}`}
              className={
                scenario === null
                  ? 'text-foreground font-semibold'
                  : 'text-muted-foreground'
              }
            >
              No state
            </Link>
            {scenarios.map((id) => (
              <Link
                key={id}
                to={`/dev/sign-in?scenario=${encodeURIComponent(id)}&next=${encodeURIComponent(next)}`}
                className={
                  scenario === id
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground'
                }
              >
                {id}
              </Link>
            ))}
          </Stack>
        </Stack>
        <DevSignInOption
          next={next}
          scenario={scenario ?? undefined}
          persona="free-owner"
          icon={<IconShield className="size-4.5" />}
          name="Free owner"
          note="Free plan · workspace owner"
        />
        <DevSignInOption
          next={next}
          scenario={scenario ?? undefined}
          persona="plus-owner"
          icon={<IconUser className="size-4.5" />}
          name="Plus owner"
          note="Plus plan · workspace owner"
        />
        <DevSignInOption
          next={next}
          scenario={scenario ?? undefined}
          persona="team-owner"
          icon={<IconShield className="size-4.5" />}
          name="Team owner"
          note="Team plan · can manage workspace access"
        />
        <DevSignInOption
          next={next}
          scenario={scenario ?? undefined}
          persona="team-member"
          icon={<IconUser className="size-4.5" />}
          name="Team member"
          note="Team plan · view-only workspace access settings"
        />
      </AuthFormStack>
    </AuthCard>
  )
}
