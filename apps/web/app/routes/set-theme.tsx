import { data } from 'react-router'
import { DEFAULT_APP_THEME, isAppTheme } from '~/lib/app-theme'
import { appThemeCookieHeader } from '~/lib/app-theme.server'
import type { Route } from './+types/set-theme'

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const value = form.get('theme')
  const theme = isAppTheme(value) ? value : DEFAULT_APP_THEME

  return data(
    { theme },
    {
      headers: { 'Set-Cookie': appThemeCookieHeader(theme) },
    },
  )
}
