import { Button } from '~/components/ui/button'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { InlineFields } from '~/components/form/inline-fields'
import { PageHeader } from '~/components/form/page-header'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { TeamMuted } from '~/components/form/team-muted'
import { Pager } from '~/components/form/pager'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'

import type { GallerySection } from './kit'
import { settingsSubheadingClassName } from '~/components/form/settings-text-styles'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { StorageMeter } from '~/components/form/storage-meter'
import { SettingsSubsection } from '~/components/form/settings-subsection'

export const formSections: GallerySection[] = [
  {
    id: 'form-pager',
    title: 'Pager',
    file: 'form/pager',
    element: (
      <Pager
        page={1}
        total={12}
        pageSize={10}
        hrefFor={(page) => `?page=${page}`}
        labels={{
          range: 'team.inventory.range',
          prev: 'team.inventory.page.prev',
          next: 'team.inventory.page.next',
        }}
      />
    ),
  },
  {
    id: 'form-settings-text-hierarchy',
    title: 'Settings Text Hierarchy',
    file: 'form/team-muted',
    element: (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">管理画面の設定</h1>
          <p className="text-muted-foreground text-sm">
            ワークスペースを管理します。
          </p>
        </div>
        <SettingsSection
          title="メンバー"
          description="参加者と権限を管理します。"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm">チームメンバー</span>
            <TeamMuted>12 件</TeamMuted>
          </div>
          <h3 className={settingsSubheadingClassName}>最近の変更</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              className="min-w-0 flex-1 basis-48"
              placeholder="メンバーを検索"
            />
            <Select defaultValue="all">
              <SelectTrigger className="w-36" aria-label="権限で絞り込む">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">すべての権限</SelectItem>
                <SelectItem value="admin">管理者</SelectItem>
                <SelectItem value="member">メンバー</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline">絞り込む</Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>メンバー</TableHead>
                <TableHead>最終更新</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>山田太郎</TableCell>
                <TableCell>
                  <TeamMuted>2 時間前</TeamMuted>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>佐藤花子</TableCell>
                <TableCell>
                  <TeamMuted>昨日</TeamMuted>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Pager
            page={1}
            total={12}
            pageSize={10}
            hrefFor={(page) => `?page=${page}`}
            labels={{
              range: 'team.inventory.range',
              prev: 'team.inventory.page.prev',
              next: 'team.inventory.page.next',
            }}
          />
        </SettingsSection>
      </div>
    ),
  },
  {
    id: 'form-page-header',
    title: 'Page Header',
    file: 'form/page-header',
    element: (
      <PageHeader
        title="設定"
        description="ワークスペースの基本設定"
        actions={<Button size="sm">保存</Button>}
      />
    ),
  },
  {
    id: 'form-settings-section',
    title: 'Settings Section',
    file: 'form/settings-section',
    element: (
      <SettingsSection
        title="プロフィール"
        description="表示名やアバターを変更します。"
        actions={
          <Button size="sm" variant="outline">
            編集
          </Button>
        }
      >
        <Field>
          <FieldLabel htmlFor="settings-name">表示名</FieldLabel>
          <Input id="settings-name" defaultValue="山田太郎" />
        </Field>
      </SettingsSection>
    ),
  },
  {
    id: 'form-settings-page',
    title: 'Settings Page',
    file: 'form/settings-page',
    element: (
      <SettingsPage>
        <SettingsSection title="一般" description="基本の設定">
          <Field>
            <FieldLabel htmlFor="settings-workspace">
              ワークスペース名
            </FieldLabel>
            <Input id="settings-workspace" defaultValue="Acme" />
          </Field>
        </SettingsSection>
        <SettingsSection title="通知" description="メール通知の設定">
          <Field>
            <FieldLabel htmlFor="settings-email">通知先メール</FieldLabel>
            <Input id="settings-email" defaultValue="team@example.com" />
          </Field>
        </SettingsSection>
      </SettingsPage>
    ),
  },
  {
    id: 'form-inline-fields',
    title: 'Inline Fields',
    file: 'form/inline-fields',
    element: (
      <InlineFields>
        <Field className="flex-1">
          <FieldLabel htmlFor="inline-first">姓</FieldLabel>
          <Input id="inline-first" placeholder="山田" />
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor="inline-last">名</FieldLabel>
          <Input id="inline-last" placeholder="太郎" />
        </Field>
      </InlineFields>
    ),
  },
  {
    id: 'form-table-empty-row',
    title: 'Table Empty Row',
    file: 'form/table-empty-row',
    element: (
      <Table>
        <TableBody>
          <TableEmptyRow colSpan={2}>表示する項目はありません。</TableEmptyRow>
        </TableBody>
      </Table>
    ),
  },
  {
    id: 'form-storage-meter',
    title: 'Storage Meter',
    file: 'form/storage-meter',
    element: <StorageMeter usedBytes={64} quotaBytes={100} />,
  },
  {
    id: 'form-settings-subsection',
    title: 'Settings Subsection',
    file: 'form/settings-subsection',
    element: <SettingsSubsection title="保存容量">内容</SettingsSubsection>,
  },
]
