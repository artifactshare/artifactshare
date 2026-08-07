import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { IconActivity, IconStack2 as Layers } from '@tabler/icons-react'
import { describe, expect, test, vi } from 'vitest'
import {
  NavigationLink,
  NavigationLinkDisabled,
  topbarClassName,
} from './navigation-link'

vi.mock('react-router', () => ({
  NavLink: ({
    children,
    to,
    className,
    ...props
  }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & {
    children: ReactNode
    to: string
    className?: string | ((args: { isActive: boolean }) => string)
  }) => {
    const resolvedClassName =
      typeof className === 'function'
        ? className({ isActive: true })
        : className
    return (
      <a href={to} className={resolvedClassName} {...props}>
        {children}
      </a>
    )
  },
}))

describe('NavigationLink', () => {
  test('topbar variant includes responsive and active classes', () => {
    const html = renderToStaticMarkup(
      <NavigationLink
        variant="topbar"
        to="/projects"
        icon={Layers}
        label="Projects"
      />,
    )

    expect(html).toContain('max-nav:w-8')
    expect(html).toContain('max-nav:hidden')
    expect(html).toContain('aria-[current=page]:font-medium')
    expect(html).toContain('>Projects<')
  })

  test('exports the shared topbar class constant', () => {
    expect(topbarClassName).toContain('h-7')
    expect(topbarClassName).toContain('px-2')
    expect(topbarClassName).toContain('aria-[current=page]:bg-accent')
  })

  test('forwards trigger props to the rendered topbar link', () => {
    const html = renderToStaticMarkup(
      <NavigationLink
        variant="topbar"
        to="/settings"
        icon={Layers}
        label="Settings"
        aria-describedby="settings-tooltip"
        data-state="closed"
      />,
    )

    expect(html).toContain('aria-describedby="settings-tooltip"')
    expect(html).toContain('data-state="closed"')
  })

  test('settings disabled surface matches navigation links', () => {
    const html = renderToStaticMarkup(
      <NavigationLinkDisabled icon={IconActivity} label="Activity" />,
    )

    expect(html).toContain('cursor-not-allowed')
    expect(html).toContain('opacity-50')
    expect(html).toContain('min-h-8')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('>Activity<')
  })
})
