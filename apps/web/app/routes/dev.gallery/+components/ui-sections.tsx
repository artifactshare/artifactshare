import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog'
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '~/components/ui/avatar'
import { Badge } from '~/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Button } from '~/components/ui/button'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '~/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '~/components/ui/input-group'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Progress } from '~/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { SegmentedControlGroup } from '~/components/ui/segmented-control'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Separator } from '~/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '~/components/ui/hover-card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command'

import type { GallerySection } from './kit'
import { Labeled, GalleryColumn } from './kit'
import {
  IconChevronDown,
  IconExclamationCircle,
  IconInbox,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconStar,
} from '@tabler/icons-react'

const SAMPLE_AVATAR =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%234f46e5"/><text x="32" y="42" font-size="30" fill="white" text-anchor="middle" font-family="sans-serif">A</text></svg>'

const BADGE_VARIANTS = [
  'default',
  'secondary',
  'destructive',
  'success',
  'info',
  'warning',
  'muted',
  'outline',
  'ghost',
  'link',
] as const

const BUTTON_VARIANTS = [
  'default',
  'outline',
  'secondary',
  'ghost',
  'destructive',
  'link',
] as const

const BUTTON_SIZES = ['xs', 'sm', 'default', 'lg'] as const

const BUTTON_ICON_SIZES = ['icon-xs', 'icon-sm', 'icon', 'icon-lg'] as const

const RADIO_OPTIONS = [
  { value: 'a', label: '選択肢 A' },
  { value: 'b', label: '選択肢 B (既定)' },
  { value: 'c', label: '選択肢 C (無効)', disabled: true },
]

const PROGRESS_VALUES = [0, 33, 66, 100]

export const uiSections: GallerySection[] = [
  {
    id: 'ui-alert',
    title: 'Alert',
    file: 'ui/alert',
    element: (
      <Stack gap="3" className="max-w-xl">
        <Alert>
          <IconInfoCircle />
          <AlertTitle>お知らせ</AlertTitle>
          <AlertDescription>これは通常の通知です。</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <IconExclamationCircle />
          <AlertTitle>エラー</AlertTitle>
          <AlertDescription>
            問題が発生しました。もう一度お試しください。
          </AlertDescription>
        </Alert>
      </Stack>
    ),
  },
  {
    id: 'ui-alert-dialog',
    title: 'Alert Dialog',
    file: 'ui/alert-dialog',
    element: (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline">確認ダイアログ</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>削除しますか?</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive">削除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  {
    id: 'ui-avatar',
    title: 'Avatar',
    file: 'ui/avatar',
    element: (
      <Inline gap="6" align="center" wrap>
        <Labeled label="size">
          <Avatar size="sm">
            <AvatarImage src={SAMPLE_AVATAR} alt="サンプル" />
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarImage src={SAMPLE_AVATAR} alt="サンプル" />
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <Avatar size="lg">
            <AvatarFallback>BC</AvatarFallback>
          </Avatar>
        </Labeled>
        <Labeled label="badge">
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
            <AvatarBadge />
          </Avatar>
        </Labeled>
        <Labeled label="group">
          <AvatarGroup>
            <Avatar>
              <AvatarFallback>A</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>B</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>C</AvatarFallback>
            </Avatar>
            <AvatarGroupCount>+3</AvatarGroupCount>
          </AvatarGroup>
        </Labeled>
      </Inline>
    ),
  },
  {
    id: 'ui-badge',
    title: 'Badge',
    file: 'ui/badge',
    element: (
      <Inline gap="2" align="center" wrap>
        {BADGE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </Inline>
    ),
  },
  {
    id: 'ui-breadcrumb',
    title: 'Breadcrumb',
    file: 'ui/breadcrumb',
    element: (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#gallery-top">ホーム</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#ui-breadcrumb">プロジェクト</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>現在のページ</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    ),
  },
  {
    id: 'ui-button',
    title: 'Button',
    file: 'ui/button',
    element: (
      <Stack gap="4">
        <Labeled label="variant">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </Labeled>
        <Labeled label="size">
          {BUTTON_SIZES.map((size) => (
            <Button key={size} size={size}>
              {size}
            </Button>
          ))}
        </Labeled>
        <Labeled label="icon size">
          {BUTTON_ICON_SIZES.map((size) => (
            <Button key={size} size={size} aria-label={`星 ${size}`}>
              <IconStar />
            </Button>
          ))}
        </Labeled>
        <Labeled label="state">
          <Button disabled>disabled</Button>
          <Button>
            <IconPlus />
            アイコン付き
          </Button>
          <Button aria-invalid="true">aria-invalid</Button>
        </Labeled>
      </Stack>
    ),
  },
  {
    id: 'ui-card',
    title: 'Card',
    file: 'ui/card',
    element: (
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>カードのタイトル</CardTitle>
          <CardDescription>補足の説明テキスト。</CardDescription>
          <CardAction>
            <Button size="xs" variant="outline">
              操作
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>本文コンテンツ。</CardContent>
        <CardFooter>
          <Button size="sm">保存</Button>
        </CardFooter>
      </Card>
    ),
  },
  {
    id: 'ui-dialog',
    title: 'Dialog',
    file: 'ui/dialog',
    element: (
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">ダイアログを開く</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ダイアログのタイトル</DialogTitle>
            <DialogDescription>本文の説明テキスト。</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    ),
  },
  {
    id: 'ui-dropdown-menu',
    title: 'Dropdown Menu',
    file: 'ui/dropdown-menu',
    element: (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            メニュー
            <IconChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>操作</DropdownMenuLabel>
          <DropdownMenuItem>複製</DropdownMenuItem>
          <DropdownMenuItem>名前を変更</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">削除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    id: 'ui-empty',
    title: 'Empty',
    file: 'ui/empty',
    element: (
      <Empty className="max-w-sm border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconInbox />
          </EmptyMedia>
          <EmptyTitle>まだ何もありません</EmptyTitle>
          <EmptyDescription>最初の項目を作成しましょう。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm">
            <IconPlus />
            作成
          </Button>
        </EmptyContent>
      </Empty>
    ),
  },
  {
    id: 'ui-field',
    title: 'Field',
    file: 'ui/field',
    element: (
      <Stack gap="6" className="max-w-md">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="field-name">表示名</FieldLabel>
            <Input id="field-name" placeholder="山田太郎" />
            <FieldDescription>一覧やコメントに表示されます。</FieldDescription>
          </Field>
          <Field data-invalid="true">
            <FieldLabel htmlFor="field-email">メールアドレス</FieldLabel>
            <Input
              id="field-email"
              aria-invalid="true"
              defaultValue="invalid"
            />
            <FieldError>メールアドレスの形式が正しくありません。</FieldError>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="field-inline">横並び</FieldLabel>
            <Input id="field-inline" placeholder="値" />
          </Field>
        </FieldGroup>
        <FieldSet>
          <FieldLegend>グループ</FieldLegend>
          <FieldDescription>関連する設定をまとめます。</FieldDescription>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="field-set-a">項目 A</FieldLabel>
              <Input id="field-set-a" />
            </Field>
            <FieldSeparator>または</FieldSeparator>
            <Field>
              <FieldLabel htmlFor="field-set-b">項目 B</FieldLabel>
              <Input id="field-set-b" />
            </Field>
          </FieldGroup>
        </FieldSet>
      </Stack>
    ),
  },
  {
    id: 'ui-input-group',
    title: 'Input Group',
    file: 'ui/input-group',
    element: (
      <GalleryColumn>
        <InputGroup>
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
          <InputGroupInput placeholder="検索" aria-label="検索" />
        </InputGroup>
        <InputGroup>
          <InputGroupInput placeholder="https://example.com" aria-label="URL" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton>コピー</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <InputGroup>
          <InputGroupInput placeholder="メモ" aria-label="メモ" />
          <InputGroupAddon align="block-end">
            <InputGroupText>0 / 200</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      </GalleryColumn>
    ),
  },
  {
    id: 'ui-input',
    title: 'Input',
    file: 'ui/input',
    element: (
      <GalleryColumn>
        <Stack gap="1.5">
          <Label htmlFor="input-default">通常</Label>
          <Input id="input-default" placeholder="placeholder" />
        </Stack>
        <Stack gap="1.5">
          <Label htmlFor="input-disabled">無効</Label>
          <Input id="input-disabled" disabled defaultValue="disabled" />
        </Stack>
        <Stack gap="1.5">
          <Label htmlFor="input-invalid">エラー</Label>
          <Input
            id="input-invalid"
            aria-invalid="true"
            defaultValue="invalid"
          />
        </Stack>
      </GalleryColumn>
    ),
  },
  {
    id: 'ui-segmented-control',
    title: 'Segmented Control',
    file: 'ui/segmented-control',
    element: (
      <SegmentedControlGroup className="border-border bg-muted inline-flex rounded-[var(--r-md)] border p-1">
        <Button variant="secondary">月払い</Button>
        <Button variant="ghost">年払い</Button>
      </SegmentedControlGroup>
    ),
  },
  {
    id: 'ui-label',
    title: 'Label',
    file: 'ui/label',
    element: (
      <Stack gap="1.5">
        <Label htmlFor="label-demo">ラベル</Label>
        <Input
          id="label-demo"
          className="max-w-xs"
          placeholder="関連づいた入力"
        />
      </Stack>
    ),
  },
  {
    id: 'ui-progress',
    title: 'Progress',
    file: 'ui/progress',
    element: (
      <Stack gap="3" className="max-w-md">
        {PROGRESS_VALUES.map((value) => (
          <Inline key={value} gap="3" align="center">
            <Progress
              value={value}
              className="w-56"
              aria-label={`進捗 ${value}%`}
            />
            <span className="text-muted-foreground text-xs tabular-nums">
              {value}%
            </span>
          </Inline>
        ))}
      </Stack>
    ),
  },
  {
    id: 'ui-radio-group',
    title: 'Radio Group',
    file: 'ui/radio-group',
    element: (
      <RadioGroup defaultValue="b" className="max-w-sm">
        {RADIO_OPTIONS.map((option) => (
          <Inline key={option.value} gap="2" align="center">
            <RadioGroupItem
              value={option.value}
              id={`radio-${option.value}`}
              disabled={option.disabled}
            />
            <Label htmlFor={`radio-${option.value}`}>{option.label}</Label>
          </Inline>
        ))}
      </RadioGroup>
    ),
  },
  {
    id: 'ui-select',
    title: 'Select',
    file: 'ui/select',
    element: (
      <Select>
        <SelectTrigger className="w-56" aria-label="サンプル選択">
          <SelectValue placeholder="選択してください" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">オプション 1</SelectItem>
          <SelectItem value="2">オプション 2</SelectItem>
          <SelectItem value="3">オプション 3</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
  {
    id: 'ui-separator',
    title: 'Separator',
    file: 'ui/separator',
    element: (
      <Stack gap="4">
        <div className="max-w-sm">
          <p className="text-sm">上のテキスト</p>
          <Separator className="my-3" />
          <p className="text-sm">下のテキスト</p>
        </div>
        <Inline gap="3" align="center" className="h-6 text-sm">
          <span>左</span>
          <Separator orientation="vertical" />
          <span>中</span>
          <Separator orientation="vertical" />
          <span>右</span>
        </Inline>
      </Stack>
    ),
  },
  {
    id: 'ui-sheet',
    title: 'Sheet',
    file: 'ui/sheet',
    element: (
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">シートを開く</Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>シートのタイトル</SheetTitle>
          </SheetHeader>
          <div className="p-3">
            <SheetDescription>右から出るパネルの本文。</SheetDescription>
          </div>
        </SheetContent>
      </Sheet>
    ),
  },
  {
    id: 'ui-sonner',
    title: 'Sonner (toast)',
    file: 'ui/sonner',
    element: (
      <Inline gap="2" wrap>
        <Button variant="outline" onClick={() => toast.success('保存しました')}>
          success
        </Button>
        <Button variant="outline" onClick={() => toast.info('お知らせです')}>
          info
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.warning('確認してください')}
        >
          warning
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.error('保存できませんでした')}
        >
          error
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.loading('保存しています')}
        >
          loading
        </Button>
      </Inline>
    ),
  },
  {
    id: 'ui-table',
    title: 'Table',
    file: 'ui/table',
    element: (
      <Table className="max-w-xl">
        <TableCaption>直近の共有</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>名前</TableHead>
            <TableHead>状態</TableHead>
            <TableHead className="text-right">件数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>レポート</TableCell>
            <TableCell>
              <Badge variant="success">公開</Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">12</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>下書き</TableCell>
            <TableCell>
              <Badge variant="muted">非公開</Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">3</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>合計</TableCell>
            <TableCell className="text-right tabular-nums">15</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    ),
  },
  {
    id: 'ui-tabs',
    title: 'Tabs',
    file: 'ui/tabs',
    element: (
      <Stack gap="6">
        <Labeled label="default">
          <Tabs defaultValue="overview" className="w-fit">
            <TabsList>
              <TabsTrigger value="overview">概要</TabsTrigger>
              <TabsTrigger value="activity">履歴</TabsTrigger>
              <TabsTrigger value="settings">設定</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">概要の内容</TabsContent>
            <TabsContent value="activity">履歴の内容</TabsContent>
            <TabsContent value="settings">設定の内容</TabsContent>
          </Tabs>
        </Labeled>
        <Labeled label="line">
          <Tabs defaultValue="one" className="w-fit">
            <TabsList variant="line">
              <TabsTrigger value="one">タブ 1</TabsTrigger>
              <TabsTrigger value="two">タブ 2</TabsTrigger>
            </TabsList>
            <TabsContent value="one">1 の内容</TabsContent>
            <TabsContent value="two">2 の内容</TabsContent>
          </Tabs>
        </Labeled>
      </Stack>
    ),
  },
  {
    id: 'ui-textarea',
    title: 'Textarea',
    file: 'ui/textarea',
    element: (
      <GalleryColumn>
        <Stack gap="1.5">
          <Label htmlFor="textarea-default">通常</Label>
          <Textarea id="textarea-default" placeholder="placeholder" />
        </Stack>
        <Stack gap="1.5">
          <Label htmlFor="textarea-disabled">無効</Label>
          <Textarea id="textarea-disabled" disabled defaultValue="disabled" />
        </Stack>
        <Stack gap="1.5">
          <Label htmlFor="textarea-invalid">エラー</Label>
          <Textarea
            id="textarea-invalid"
            aria-invalid="true"
            defaultValue="invalid"
          />
        </Stack>
      </GalleryColumn>
    ),
  },
  {
    id: 'ui-hover-card',
    title: 'HoverCard',
    file: 'ui/hover-card',
    element: (
      <HoverCard>
        <HoverCardTrigger asChild>
          <button type="button">Hover</button>
        </HoverCardTrigger>
        <HoverCardContent>Preview</HoverCardContent>
      </HoverCard>
    ),
  },
  {
    id: 'ui-command',
    title: 'Command',
    file: 'ui/command',
    element: (
      <Command className="ring-foreground/10 max-w-sm ring-1">
        <CommandInput placeholder="検索" />
        <CommandList>
          <CommandEmpty>一致するものはありません</CommandEmpty>
          <CommandGroup heading="プロジェクト">
            <CommandItem>Measurement platform</CommandItem>
            <CommandItem>CS reply drafts</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    ),
  },
  {
    id: 'ui-tooltip',
    title: 'Tooltip',
    file: 'ui/tooltip',
    element: (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">ホバーで表示</Button>
          </TooltipTrigger>
          <TooltipContent>ツールチップの説明</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  },
]
