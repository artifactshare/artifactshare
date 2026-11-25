import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { IconActivity, IconStack2 as Layers } from '@tabler/icons-react'
import { describe, expect, test, vi } from 'vitest'
import { NavigationLink, NavigationLinkDisabled } from './navigation-link'

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

// Here: the element a reader gets, its destination, the props passed through
// to it, and the disabled state a screen reader announces.
describe('NavigationLink', () => {
  test('topbar variant renders a labeled link to its destination', () => {
    const html = renderToStaticMarkup(
      <NavigationLink
        variant="topbar"
        to="/projects"
        icon={Layers}
        label="Projects"
      />,
    )

    expect(html).toContain('href="/projects"')
    expect(html).toContain('>Projects<')
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

  test('a disabled settings entry is announced and is not a link', () => {
    const html = renderToStaticMarkup(
      <NavigationLinkDisabled icon={IconActivity} label="Activity" />,
    )

    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('>Activity<')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
  })
})
