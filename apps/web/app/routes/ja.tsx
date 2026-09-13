import { Landing } from './_home/+components/landing'
import { landingMeta } from '~/lib/landing-meta'
import type { Route } from './+types/ja'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'landing',
  route: {
    en: '/',
    ja: '/ja',
  },
  auth: 'anonymous',
  loop: 'support',
  metric: '製品理解を高め、利用開始につなげる',
  role: 'サービスの価値と入口を伝える',
  primaryAction: 'サービスを始める',
  states: [
    {
      id: 'default',
      description: '通常のマーケティング LP (MCP タブ・リビール完了後)',
      setup: {},
    },
    {
      id: 'cli-tab',
      description: 'ヒーローの接続手段を CLI タブへ切り替えた状態',
      setup: {
        interactions: [
          {
            action: 'click',
            selector: '[role="tab"]:has-text("CLI")',
          },
        ],
      },
    },
    {
      id: 'focused-sign-in',
      description: '行き先つきリダイレクト (?next=) が出す集中サインイン表示',
      setup: {
        query: '?next=/projects/example',
      },
    },
    {
      id: 'invite',
      description: '招待リンク (?next=/a/…) が出す招待向けサインイン表示',
      setup: {
        query: '?next=/a/example',
      },
    },
  ],
} satisfies ScreenSpec

export function meta() {
  return landingMeta('ja')
}

export default function JaLandingRoute() {
  return <Landing />
}
