import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import { avatarSlotFor } from '~/lib/user'
import { cn } from '~/lib/utils'

const sizeClassName = {
  xs: 'size-3.5',
  sm: 'size-5',
  menu: 'size-6.5',
} as const

const sizePx = {
  xs: 14,
  sm: 20,
  menu: 26,
} as const

interface AuthorAvatarProps {
  id: string
  image: string | null
  initial: string
  /** `xs` for viewer chrome subtitle (14px), `sm` for lists/comments (20px), `menu` for account menu (26px). */
  size?: keyof typeof sizeClassName
  /** `<img loading>` 属性のみを制御する (`fetchPriority` には影響しない)。default `'lazy'`。 */
  loading?: 'eager' | 'lazy'
  className?: string
}

export function AuthorAvatar({
  id,
  image,
  initial,
  size = 'sm',
  loading = 'lazy',
  className,
}: AuthorAvatarProps) {
  const imageSize = sizePx[size]
  return (
    <Avatar
      className={cn(
        'text-card inline-flex overflow-hidden text-xs font-medium after:hidden',
        sizeClassName[size],
        className,
      )}
    >
      {image ? (
        // Radix AvatarImage は hydration 後まで img を出さず SSR HTML に src が
        // 載らない (一覧でイニシャル→写真のフラッシュ、lazy loading も無効化)
        // ため、素の img を使う。
        // Google プロフィール画像 (`lh3.googleusercontent.com`) は referer を
        // 見て第三者リクエストを 429/403 で蹴ることがある。`no-referrer` で
        // referer ヘッダを落として確実に通す。
        <img
          className="aspect-square size-full rounded-full object-cover"
          src={image}
          alt=""
          width={imageSize}
          height={imageSize}
          loading={loading === 'eager' ? undefined : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : (
        <AvatarFallback
          className="text-xs text-inherit"
          style={{ background: `var(--avatar-${avatarSlotFor(id)})` }}
        >
          {initial}
        </AvatarFallback>
      )}
    </Avatar>
  )
}
