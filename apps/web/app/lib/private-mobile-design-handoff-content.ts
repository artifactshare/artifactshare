import type { Locale } from '~/i18n/messages'

export interface PrivateMobileDesignHandoffContent {
  title: string
  description: string
  copyLabels: { copy: string; copied: string; failed: string }
  canonicalPath: string
  og: { title: string; description: string; imageAlt: string; subhead: string }
  links: { cliReference: string; updates: string }
}

const EN: PrivateMobileDesignHandoffContent = {
  title: 'Keep a mobile design document private when handing it to a PC',
  description:
    'Share a mobile design document privately from an agent, then continue it on a PC. One share command with --visibility private is all it takes.',
  copyLabels: {
    copy: 'Copy Markdown',
    copied: 'Copied',
    failed: 'Copy failed',
  },
  canonicalPath: '/guides/private-mobile-design-handoff',
  og: {
    title: 'Private mobile design handoff',
    description:
      'Share a mobile design document privately from an agent, then continue it on a PC with a single share command.',
    imageAlt: 'Private mobile design handoff guide',
    subhead: 'Share privately from a mobile agent, then continue on a PC',
  },
  links: { cliReference: '/guides/cli', updates: '/updates' },
}

const JA: PrivateMobileDesignHandoffContent = {
  title: 'モバイルの設計文書を非公開のまま PC へ引き継ぐ',
  description:
    'モバイルのエージェントから設計文書を自分だけに見える状態で共有し、PC で続きをする方法を案内します。共有コマンドに --visibility private を付けるだけで完結します。',
  copyLabels: {
    copy: 'Markdown をコピー',
    copied: 'コピーしました',
    failed: 'コピーできませんでした',
  },
  canonicalPath: '/ja/guides/private-mobile-design-handoff',
  og: {
    title: 'モバイルの設計文書を非公開のまま PC へ引き継ぐ',
    description:
      'モバイルのエージェントから設計文書を非公開で共有し、PC で続きをする方法です。共有コマンド 1 つで完結します。',
    imageAlt: 'モバイルの設計文書を非公開のまま PC へ引き継ぐガイド',
    subhead: 'モバイルのエージェントから PC へ非公開で引き継ぐ',
  },
  links: { cliReference: '/guides/cli', updates: '/updates' },
}

export function privateMobileDesignHandoffContent(
  locale: Locale,
): PrivateMobileDesignHandoffContent {
  return locale === 'ja' ? JA : EN
}
