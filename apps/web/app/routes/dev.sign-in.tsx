import { redirect } from 'react-router'
import type { Route } from './+types/dev.sign-in'
import { AuthCard, AuthFormStack } from '~/components/app/auth-card'
import { DevSignInOption } from '~/components/app/dev-sign-in-option'
import { isViteDev } from '~/lib/is-vite-dev'
import { safeInternalNext } from '~/lib/safe-next'
import { authHandlerWithHangDetection } from '~/services/auth.server'
import { IconShield, IconUser } from '@tabler/icons-react'

const DEFAULT_NEXT = '/settings/tokens'

function safeDevSignInTarget(next: unknown): string {
  if (next == null) return DEFAULT_NEXT
  const path = safeInternalNext(next)
  return path === '/' && next !== '/' ? DEFAULT_NEXT : path
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
  return { next: safeDevSignInTarget(url.searchParams.get('next')) }
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
      body: JSON.stringify({ persona }),
    }),
  )

  if (!authResponse.ok) {
    throw new Response('Sign-in failed', { status: authResponse.status })
  }

  const redirectHeaders = new Headers()
  appendSetCookies(authResponse, redirectHeaders)
  return redirect(safeNext, { headers: redirectHeaders })
}

export default function DevSignIn({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const { next } = loaderData

  return (
    <AuthCard
      title="Local dev sign-in"
      sub="Fixed dev users for this workspace. Unavailable outside Vite dev."
    >
      <AuthFormStack aria-label="Dev users">
        <DevSignInOption
          next={next}
          persona="free-owner"
          icon={<IconShield className="size-4.5" />}
          name="Free owner"
          note="Free plan · workspace owner"
        />
        <DevSignInOption
          next={next}
          persona="plus-owner"
          icon={<IconUser className="size-4.5" />}
          name="Plus owner"
          note="Plus plan · workspace owner"
        />
        <DevSignInOption
          next={next}
          persona="team-owner"
          icon={<IconShield className="size-4.5" />}
          name="Team owner"
          note="Team plan · can manage workspace access"
        />
        <DevSignInOption
          next={next}
          persona="team-member"
          icon={<IconUser className="size-4.5" />}
          name="Team member"
          note="Team plan · view-only workspace access settings"
        />
      </AuthFormStack>
    </AuthCard>
  )
}
