import { redirect } from 'react-router'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { isSupportedLocale, localeCookieHeader } from '~/lib/i18n.server'
import { safeInternalNext } from '~/lib/safe-next'
import { userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import type { Route } from './+types/set-locale'

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const value = form.get('locale')
  const next = form.get('next')

  const locale = isSupportedLocale(value) ? value : DEFAULT_LOCALE
  const target = safeInternalNext(next)
  const user = context.get(userContext)

  if (user) {
    const db = createDb()
    await db
      .updateTable('users')
      .set({ locale })
      .where('id', '=', user.id)
      .execute()
  }

  return redirect(target, {
    headers: { 'Set-Cookie': localeCookieHeader(locale) },
  })
}
