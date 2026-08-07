import {
  IconCopy,
  IconDots as Ellipsis,
  IconStack2 as Layers,
} from '@tabler/icons-react'

import { AuthorAvatar } from '~/components/app/author-avatar'
import { BrandMark } from '~/components/app/brand-mark'
import { PublicFooter } from '~/components/app/public-footer'
import { IconButton } from '~/components/app/icon-button'
import {
  NavigationLink,
  NavigationLinkDisabled,
} from '~/components/app/navigation-link'
import { TabNav, TabNavLink } from '~/components/app/tab-nav'
import { Inline } from '~/components/layout/inline'

import type { GallerySection } from './kit'
import { Labeled } from './kit'

const BRAND_MARK_SIZES = [16, 20, 24, 32] as const
const AVATAR_SIZES = ['xs', 'sm', 'menu'] as const

export const appSections: GallerySection[] = [
  {
    id: 'app-brand-mark',
    title: 'Brand Mark',
    file: 'app/brand-mark',
    element: (
      <Labeled label="size">
        {BRAND_MARK_SIZES.map((size) => (
          <BrandMark key={size} size={size} aria-hidden="true" />
        ))}
      </Labeled>
    ),
  },
  {
    id: 'app-author-avatar',
    title: 'Author Avatar',
    file: 'app/author-avatar',
    element: (
      <Labeled label="size">
        {AVATAR_SIZES.map((size) => (
          <AuthorAvatar
            key={size}
            id={`gallery-${size}`}
            image={null}
            initial="A"
            size={size}
          />
        ))}
      </Labeled>
    ),
  },
  {
    id: 'app-icon-button',
    title: 'Icon Button',
    file: 'app/icon-button',
    element: (
      <Inline gap="3" align="center">
        <IconButton icon={IconCopy} size="sm" aria-label="Copy small" />
        <IconButton icon={Ellipsis} size="md" aria-label="More medium" />
      </Inline>
    ),
  },
  {
    id: 'app-navigation-link',
    title: 'Navigation Link',
    file: 'app/navigation-link',
    element: (
      <Inline gap="3" align="center" wrap>
        <NavigationLink
          variant="topbar"
          to="/projects"
          icon={Layers}
          label="Projects"
        />
        <TabNav aria-label="Settings navigation" orientation="responsive">
          <TabNavLink
            to="/settings"
            icon={Layers}
            label="Settings"
            orientation="responsive"
          />
        </TabNav>
        <TabNav aria-label="Inventory tabs">
          <TabNavLink to="/settings/inventory/projects" label="Projects" end />
          <TabNavLink to="/settings/inventory/artifacts" label="Artifacts" />
        </TabNav>
        <NavigationLinkDisabled icon={Layers} label="Disabled" />
      </Inline>
    ),
  },
  {
    id: 'app-public-footer',
    title: 'Public Footer',
    file: 'app/public-footer',
    element: (
      <div className="w-full">
        <PublicFooter />
        <PublicFooter variant="minimal" />
      </div>
    ),
  },
]
