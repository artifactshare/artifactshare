import { Link, type LinkProps } from 'react-router'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export function AppMoreLink({
  as = 'link',
  className,
  ...props
}: (
  | LinkProps
  | (ButtonHTMLAttributes<HTMLButtonElement> & { as: 'button' })
) & { as?: 'link' | 'button' }) {
  const classes = cn(
    'text-link text-sm no-underline hover:underline',
    className,
  )
  if (as === 'button')
    return (
      <button
        type="button"
        className={classes}
        {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}
      />
    )
  return <Link className={classes} {...(props as LinkProps)} />
}
