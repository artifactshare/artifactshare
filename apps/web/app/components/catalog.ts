export type ComponentCatalogEntry = {
  /** 部品ファイル参照。例: 'ui/button' / 'form/page-header'。parity と gallery 共通の基準。 */
  file: string
  name: string
  /** いつ使うか。1 文の用途。 */
  purpose: string
  /** 提供する variant / size。無ければ空配列。値は各部品の cva 定義から裏取りする。 */
  variants: string[]
  /** shadcn 公式からの独自差分。公式に対応が無い自前部品や差分なしは null。 */
  upstreamDiff: string | null
}

/**
 * `components/ui/`、`components/form/`、`components/layout/` の部品カタログ。
 * app 部品は用途固有のため parity 対象外で、代表形を /dev/gallery の app-sections に掲載する。
 * 「何があり、いつ使い、どの variant を持ち、公式から何が違うか」を機械可読に持つ。
 * design-system.md は語彙と意図を、値は @theme / 部品コードを、部品一覧はこのカタログを正本にする。
 * 実在部品との一致は catalog.test.ts が検査する (欠け・孤児・重複・空メタ・代表差分の存在)。
 */
export const componentCatalog: ComponentCatalogEntry[] = [
  {
    file: 'app/app-page-header',
    name: 'AppPageHeader',
    purpose: '一覧系アプリ画面のページ見出しと説明・操作の配置を統一する。',
    variants: ['leading', 'badges', 'meta', 'actions'],
    upstreamDiff: 'アプリ画面専用のページシェル。',
  },
  {
    file: 'app/app-section-header',
    name: 'AppSectionHeader',
    purpose: '一覧セクションの見出し、件数、補助情報、右側操作を統一する。',
    variants: ['count', 'meta', 'actions'],
    upstreamDiff: 'アプリ画面専用のセクションシェル。',
  },
  {
    file: 'app/app-divider-list',
    name: 'AppDividerList',
    purpose: 'border 区切り一覧の外側構造を統一する。',
    variants: [],
    upstreamDiff: 'アプリ画面専用の一覧シェル。',
  },
  {
    file: 'app/app-more-link',
    name: 'AppMoreLink',
    purpose: '一覧の続きへのリンクの色と装飾を統一する。',
    variants: [],
    upstreamDiff: 'アプリ画面専用のリンクシェル。',
  },
  {
    file: 'app/app-empty-state',
    name: 'AppEmptyState',
    purpose: '一覧系画面の意味を持つ空状態の semantic 構造を統一する。',
    variants: ['icon', 'body', 'action'],
    upstreamDiff: 'shadcn Empty をアプリ画面用に合成する。',
  },
  {
    file: 'ui/alert',
    name: 'Alert',
    purpose:
      '注意喚起・状態バナー。ARIA role は用途に合わせ使用側で上書きする。',
    variants: ['variant: default / destructive'],
    upstreamDiff: null,
  },
  {
    file: 'ui/alert-dialog',
    name: 'AlertDialog',
    purpose: '破壊的操作の確認ダイアログ (取り消し / 実行の二択)。',
    variants: ['AlertDialogContent size: default / sm'],
    upstreamDiff: null,
  },
  {
    file: 'ui/avatar',
    name: 'Avatar',
    purpose:
      'ユーザー / ワークスペースの丸アイコン。AuthorAvatar の土台。presence と重なりは AvatarBadge / AvatarGroup で表す。',
    variants: ['size: default / sm / lg'],
    upstreamDiff: null,
  },
  {
    file: 'ui/badge',
    name: 'Badge',
    purpose: 'ステータス pill と VisibilityChip の土台。',
    variants: [
      'variant: default / secondary / destructive / success / info / warning / muted / outline / ghost / link',
    ],
    upstreamDiff:
      'success / info / warning / muted / ghost / link variant を追加 (semantic token を参照)。',
  },
  {
    file: 'ui/breadcrumb',
    name: 'Breadcrumb',
    purpose: '階層ナビ。React Router Link を BreadcrumbLink asChild で包む。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/button',
    name: 'Button',
    purpose: '主要 CTA と操作トリガ。ボタンはこれ 1 実装に統一する。',
    variants: [
      'variant: default / outline / secondary / ghost / destructive / link',
      'size: default / xs / sm / lg / icon / icon-xs / icon-sm / icon-lg',
    ],
    upstreamDiff:
      'shadcn 既定に無い xs / icon-xs / icon-sm / icon-lg サイズを追加。primary 色は app.css の semantic token で与える。',
  },
  {
    file: 'ui/card',
    name: 'Card',
    purpose: '設定画面などのカード枠 (Header / Content / Footer / Action)。',
    variants: ['size: default / sm'],
    upstreamDiff: null,
  },
  {
    file: 'ui/dialog',
    name: 'Dialog',
    purpose: '汎用モーダルダイアログ (確認以外)。',
    variants: [],
    upstreamDiff:
      'DialogContent に [&>*]:min-w-0 を追加 (折り返し不能な子が grid 列をダイアログ幅より広げないため)。',
  },
  {
    file: 'ui/dropdown-menu',
    name: 'DropdownMenu',
    purpose: 'アクションメニュー (⋯ メニューなど)。danger 項目は red。',
    variants: ['DropdownMenuItem variant: default / destructive'],
    upstreamDiff: null,
  },
  {
    file: 'ui/empty',
    name: 'Empty',
    purpose:
      '空状態・エラー表示 (Header / Media / Title / Description / Content)。DeniedPanel も同構成。',
    variants: ['EmptyMedia variant: default / icon'],
    upstreamDiff: null,
  },
  {
    file: 'ui/field',
    name: 'Field',
    purpose: 'label + control + 説明 + エラーの束。フォームの最小単位。',
    variants: [
      'orientation: vertical / horizontal / responsive',
      'FieldLegend variant: legend / label',
    ],
    upstreamDiff: null,
  },
  {
    file: 'ui/input-group',
    name: 'InputGroup',
    purpose: '入力に addon / ボタン / アイコンを内包する複合入力。',
    variants: [
      'InputGroupAddon align: inline-start / inline-end / block-start / block-end',
      'InputGroupButton size: xs / sm / icon-xs / icon-sm',
    ],
    upstreamDiff: null,
  },
  {
    file: 'ui/input',
    name: 'Input',
    purpose:
      '単一行テキスト入力 (葉コントロール)。高さ・radius は shadcn 既定。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/segmented-control',
    name: 'SegmentedControlGroup',
    purpose: '排他的な選択肢を連結した一つの操作群として扱う。',
    variants: [],
    upstreamDiff: 'Artifact Share 固有の余白監査境界を所有。',
  },
  {
    file: 'ui/label',
    name: 'Label',
    purpose: 'フォームラベル。隠す場合は sr-only。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/progress',
    name: 'Progress',
    purpose: '使用量メーターなどの進捗バー。装飾扱いなら aria-hidden。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/radio-group',
    name: 'RadioGroup',
    purpose:
      '単一選択のラジオ群。非制御フォームでは Root に name + defaultValue を渡す。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/select',
    name: 'Select',
    purpose: 'ドロップダウン選択 (葉コントロール)。',
    variants: ['SelectTrigger size: default / sm'],
    upstreamDiff: null,
  },
  {
    file: 'ui/separator',
    name: 'Separator',
    purpose: '区切り線 (水平 / 垂直)。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/sheet',
    name: 'Sheet',
    purpose: '端からのスライドオーバーレイ (side で方向)。',
    variants: ['side: top / right / bottom / left'],
    upstreamDiff:
      '幅を shadcn 既定の w-3/4 から固定 w-[340px] (max-w-[95vw]) に変更。',
  },
  {
    file: 'ui/sonner',
    name: 'Toaster (Sonner)',
    purpose:
      'トースト通知。同時 1 件、成功は緑チェック、破壊的操作は確認ダイアログを優先。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/table',
    name: 'Table',
    purpose:
      '一覧テーブル (semantic table)。手組みの role="table" を新設しない。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/tabs',
    name: 'Tabs',
    purpose:
      'タブ切替。value / onValueChange の制御モードで既存 state に接続する。',
    variants: ['variant: default / line'],
    upstreamDiff: null,
  },
  {
    file: 'ui/textarea',
    name: 'Textarea',
    purpose: '複数行テキスト入力。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/hover-card',
    name: 'HoverCard',
    purpose:
      'リンク先の概要を hover / focus で補助表示するカード。一覧行のファイル / プロジェクト peek にも使う (カード内は無操作、遷移は行リンク側)。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'ui/command',
    name: 'Command',
    purpose:
      '⌘K 検索パレット (cmdk)。CommandDialog + CommandInput + CommandGroup で 3 セクション検索を組む。',
    variants: [],
    upstreamDiff:
      'CommandDialog に shouldFilter を追加 (サーバ側検索でクライアント filter を切る)。',
  },
  {
    file: 'ui/tooltip',
    name: 'Tooltip',
    purpose:
      'アイコンボタンなどの補助ラベル。Provider は root.tsx に配置済み。',
    variants: [],
    upstreamDiff:
      'TooltipContent に pointer-events-none を追加 (表示中に下の要素の操作を奪わない)。',
  },
  {
    file: 'form/inline-fields',
    name: 'InlineFields',
    purpose:
      '入力 + ボタンの横並び。gap-inline を所有し、stack 境界以下で縦積みにする。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'app/page-breadcrumb',
    name: 'PageBreadcrumb',
    purpose: '一覧ページのパンくずと見出しへの縦リズムを所有する。',
    variants: [],
    upstreamDiff:
      'shadcn Breadcrumb に見出しとの間隔 mb-2 を追加する薄い wrapper。',
  },
  {
    file: 'form/page-header',
    name: 'PageHeader',
    purpose: 'ページ見出し (h1) + 説明 + 右端 actions。外側余白を持たない。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/settings-page',
    name: 'SettingsPage',
    purpose: 'セクションの縦積み。gap-section を所有する。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/settings-section',
    name: 'SettingsSection',
    purpose: 'h2 + 説明 + 右端 actions + 内容。内容の gap-field を所有する。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/team-muted',
    name: 'TeamMuted / TeamMutedParagraph',
    purpose:
      '設定画面の補助テキスト。TeamMuted はメタ (text-xs)、TeamMutedParagraph は説明 (text-sm) の段を内包する。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/pager',
    name: 'Pager',
    purpose: '一覧の範囲表示と前後ページ移動。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/table-empty-row',
    name: 'TableEmptyRow',
    purpose: 'テーブル内の標準空状態。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/storage-meter',
    name: 'StorageMeter',
    purpose: '保存容量の使用量メーター。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'form/settings-subsection',
    name: 'SettingsSubsection',
    purpose: '設定内の見出し付き小ブロック。',
    variants: [],
    upstreamDiff: null,
  },
  {
    file: 'layout/stack',
    name: 'Stack',
    purpose:
      '縦方向の一方向フロー。gap / align / justify / wrap は props で指定し、className では padding・幅・surface・typography・局所的 responsive 制約だけを許す。',
    variants: [
      'gap: 0 / 0.5 / 1 / 1.5 / 2 / 3 / 4 / 5 / 6 / 8 / 10 / 12 / 16 / 20 / 24',
      'align: start / center / end / stretch / baseline',
      'justify: start / center / end / between / around / evenly',
      'wrap: true / false',
    ],
    upstreamDiff: null,
  },
  {
    file: 'layout/inline',
    name: 'Inline',
    purpose:
      '横方向の一方向フロー。gap / align / justify / wrap は props で指定し、className では padding・幅・surface・typography・局所的 responsive 制約だけを許す。',
    variants: [
      'gap: 0 / 0.5 / 1 / 1.5 / 2 / 3 / 4 / 5 / 6 / 8 / 10 / 12 / 16 / 20 / 24',
      'align: start / center / end / stretch / baseline',
      'justify: start / center / end / between / around / evenly',
      'wrap: true / false',
    ],
    upstreamDiff: null,
  },
]
