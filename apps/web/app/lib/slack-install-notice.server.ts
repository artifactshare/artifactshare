import { createCookie, redirect } from 'react-router'

const notice = createCookie('slack-install-notice', {
  path: '/settings',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 60,
})

export async function slackInstallFailure(code: string) {
  return redirect('/settings/integrations', {
    headers: { 'Set-Cookie': await notice.serialize(code) },
  })
}

export async function readSlackInstallFailure(request: Request) {
  const code: unknown = await notice.parse(request.headers.get('Cookie'))
  if (code !== 'forbidden' && code !== 'not-found') return null
  return { code, clearCookie: await notice.serialize('', { maxAge: 0 }) }
}
