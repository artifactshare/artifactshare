export const SPACING_OWNERSHIP_POLICY = [
  {
    file: 'apps/web/app/components/app/guide-language-switcher.tsx',
    component: 'GuideLanguageSwitcher',
    usage: 'guide locale links',
    ownership: 'parent-owned',
    reason:
      'the surrounding guide shell owns section rhythm; switcher is an inline control',
  },
  {
    file: 'apps/web/app/components/app/auth-card.tsx',
    component: 'AuthBlock',
    usage: 'provider block below auth card content',
    ownership: 'parent-owned',
    reason:
      'AuthCard content stack owns vertical rhythm; block spacing is kept at its parent boundary',
  },
  {
    file: 'apps/web/app/components/app/auth-card.tsx',
    component: 'AuthAlert',
    usage: 'error notice below auth card content',
    ownership: 'semantic-owner',
    reason:
      'an alert is a semantic status surface and its separation from the title is part of the component contract',
  },
]
