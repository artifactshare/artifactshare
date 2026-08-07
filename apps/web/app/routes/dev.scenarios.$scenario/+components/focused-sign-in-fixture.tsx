import {
  AuthCard,
  AuthDivider,
  AuthFootnote,
  AuthHint,
  AuthProviders,
} from '~/components/app/auth-card'
import { Stack } from '~/components/layout/stack'
import { Button } from '~/components/ui/button'
import { FixtureFooter } from './fixture-footer'

export function FocusedSignInFixture() {
  return (
    <div data-regression-region="main">
      <AuthCard
        mark
        title="Sign in"
        sub="Sign in with your account to continue."
        footer={<FixtureFooter variant="minimal" />}
      >
        <AuthProviders>
          <Stack gap="2">
            <Button
              type="button"
              variant="outline"
              data-regression-primary="continue"
            >
              Continue with Google
            </Button>
            <Button type="button" variant="outline">
              Continue with Microsoft
            </Button>
          </Stack>
        </AuthProviders>
        <AuthDivider>or</AuthDivider>
        <AuthFootnote>
          <AuthHint>
            Email-code sign-in is for viewing and commenting. To upload, use
            Google or Microsoft.
          </AuthHint>
          <Button type="button" variant="link">
            Use email
          </Button>
        </AuthFootnote>
      </AuthCard>
    </div>
  )
}
