export const taskFlowPhases = [
  'start',
  'action',
  'pending',
  'success',
  'failure',
  'recovery',
  'next',
]

export const taskLoopStages = new Set([
  'publish',
  'share',
  'view',
  'react',
  'republish',
])

export const personaMediations = new Set([
  'human-direct',
  'agent-mediated',
  'mixed',
])

// 利用者像の正本。各タスクは persona を 1 つ参照する。
// mediation は主要な操作の担い手 (本人が直接操作するか、AI エージェントに任せるか)。
// auth は persona の既定の文脈を再現する dev sign-in persona。
export const personas = [
  {
    id: 'ai-native-poster',
    name: 'AI ネイティブ投稿者',
    summary:
      'まず自分のために AI エージェントで作った成果物を URL にして見直し、考えを進める投稿者。まとまったらチームと coding agent へ渡す。投稿と更新はエージェントに任せ、本人は共有 URL と画面で結果を確認する。',
    mediation: 'agent-mediated',
    auth: 'team-owner',
  },
  {
    id: 'first-time-explorer',
    name: 'ひとりで試す初回投稿者',
    summary:
      '記事や紹介をきっかけに個人で登録し、手元のファイルを Web から直接アップロードして試す利用者。まだ共有相手が決まっておらず、価値の確認が目的。',
    mediation: 'human-direct',
    auth: 'free-owner',
  },
  {
    id: 'link-receiver',
    name: '共有リンクの受け手',
    summary:
      '同僚や関係者から共有 URL を受け取って閲覧する利用者。AI ツールの利用者とは限らず、閲覧から始まり、次の投稿者になり得る。既定の開始文脈は未認証で、必要になった時点でサインインする。',
    mediation: 'human-direct',
    auth: 'anonymous',
  },
  {
    id: 'team-collaborator',
    name: 'チームの継続利用メンバー',
    summary:
      '所属ワークスペースの共有物を読み、コメントし、自分でも投稿するメンバー。プロジェクトの文脈でファイルを探し、仕事の流れの中で再訪する。',
    mediation: 'mixed',
    auth: 'team-member',
  },
]

export const selectionCriteria = [
  '投稿、共有、閲覧、反応、再投稿の輪を前へ進める主要な利用者タスクである',
  '複数の画面または一つの画面内の複数状態をまたぎ、画面単体の検査だけでは断絶を見落とし得る',
  '成功だけでなく、処理中、失敗、回復、次の行動まで再現して評価する価値がある',
]

export const changeProcedure = [
  '利用者は personas 正本から選んで参照し、観測した利用状況が persona 定義と食い違う場合は persona 側を先に更新する',
  '既存タスクと目的、利用者、開始状況が重複しないか確認する',
  '選定基準を満たすタスクだけを追加し、観測した利用状況が変わった場合は既存項目を更新する',
  '全 phase と参照画面を記入し、pnpm check:task-ledger で画面台帳との整合を確認する',
  '画面や状態の追加が必要なら画面台帳を先に更新し、タスク台帳から存在しない将来状態を参照しない',
  'タスクの変更時は、walkthrough、批評観点、関連する自動テストへの影響を確認する',
]

const flow = ({ start, action, pending, success, failure, recovery, next }) => [
  { phase: 'start', ...start },
  { phase: 'action', ...action },
  { phase: 'pending', ...pending },
  { phase: 'success', ...success },
  { phase: 'failure', ...failure },
  { phase: 'recovery', ...recovery },
  { phase: 'next', ...next },
]

export const tasks = [
  {
    id: 'return-to-recent-file',
    title: '最近見たファイルへ戻る',
    persona: 'team-collaborator',
    actor: '以前見たファイルをもう一度確認したい利用者',
    startingSituation:
      '複数のファイルを閲覧した後で、名前や保存先を正確には覚えていない',
    prerequisite:
      '最近見たファイルが複数あり、目的のファイルが最近見た一覧に記録されている',
    goal: '見覚えのある情報から目的のファイルを発見し、内容を再確認する',
    completion: '目的のファイルが Viewer で表示されている',
    confirmation:
      'Viewer のタイトル、内容、所有者または保存先から目的のファイルだと判断できる',
    loopStage: 'view',
    metric: '再訪した利用者が目的のファイルへ到達できる割合',
    flow: flow({
      start: {
        description: 'Home から最近見たファイルを探し始める',
        screens: ['home/default'],
      },
      action: {
        description: '候補を確認し、必要なら最近見た一覧を開いて選ぶ',
        screens: ['home/default', 'recent/content-rich'],
      },
      pending: {
        description: '選んだファイルの Viewer が内容を読み込む',
        screens: ['viewer/default'],
      },
      success: {
        description: '目的のファイルの内容を確認できる',
        screens: ['viewer/default'],
      },
      failure: {
        description: 'Home の候補だけでは目的のファイルを特定できない',
        screens: ['home/default'],
      },
      recovery: {
        description: '最近見た一覧へ移り、候補を広げて探し直す',
        screens: ['recent/content-rich'],
      },
      next: {
        description: '内容を確認し、共有または反応の確認へ進む',
        screens: ['viewer/default'],
      },
    }),
  },
  {
    id: 'publish-first-file',
    title: '最初のファイルを Web から投稿して結果を確認する',
    persona: 'first-time-explorer',
    actor: '手元のファイルを初めて自分で投稿する利用者',
    startingSituation:
      '共有したいローカルファイルがあり、まだ投稿したことがない',
    prerequisite: '対応形式のファイルと、利用可能なアカウントを持っている',
    goal: 'ファイルを投稿し、共有可能な状態になったことを確認する',
    completion: '投稿したファイルが Home と Viewer から確認できる',
    confirmation: '投稿したタイトルと内容、および共有リンクが画面に表示される',
    loopStage: 'publish',
    metric: '初回投稿を開始した利用者の投稿完了率',
    flow: flow({
      start: {
        description: 'Home の空の状態からアップロードを始める',
        screens: ['home/empty'],
      },
      action: {
        description: 'アップロードダイアログでファイルを選んで投稿する',
        screens: ['home/upload-dialog'],
      },
      pending: {
        description: 'アップロード処理の完了を待つ',
        screens: ['home/upload-dialog'],
      },
      success: {
        description: 'Home に最初のファイルが現れ、Viewer で内容を確認できる',
        screens: ['home/first-file', 'viewer/default'],
      },
      failure: {
        description:
          '形式やサイズ、アップロード可否の制限でダイアログから先へ進めない',
        screens: ['home/upload-dialog'],
      },
      recovery: {
        description: '利用開始の案内で対応形式と手順を確認して再実行する',
        screens: ['start/default', 'home/empty'],
      },
      next: {
        description: '投稿したファイルを開いて共有へ進む',
        screens: ['viewer/default'],
      },
    }),
  },
  {
    id: 'confirm-agent-publish',
    title: 'エージェントに任せた投稿の結果を確認する',
    persona: 'ai-native-poster',
    actor: '成果物の投稿を AI エージェントに任せた投稿者',
    startingSituation:
      'エージェントへ投稿を依頼して完了報告を受けたが、共有 URL は開かずに別端末を含む Home を見ている',
    prerequisite:
      'エージェントが自分のアカウントで接続済みで、投稿対象の成果物がある',
    goal: '投稿が意図した内容と保存先で完了したことを自分で確認する',
    completion:
      '投稿されたファイルを Viewer で確認し、保存先と公開範囲を把握している',
    confirmation: 'Viewer のタイトル、本文、保存先表示が依頼した内容と一致する',
    loopStage: 'publish',
    metric: 'エージェント経由の投稿を投稿者本人が確認する割合',
    flow: flow({
      start: {
        description: 'Home の「未確認のファイル」から投稿結果を探し始める',
        screens: ['home/unopened-file'],
      },
      action: {
        description: '対象ファイルを選び、内容、保存先、公開範囲を確認する',
        screens: ['home/unopened-file', 'viewer/default'],
      },
      pending: {
        description: 'Viewer の読み込みを待つ',
        screens: ['viewer/default'],
      },
      success: {
        description:
          '依頼した内容が意図した保存先に投稿され、Home では「最近見たもの」へ移っている',
        screens: ['viewer/default', 'home/default'],
      },
      failure: {
        description:
          '対象が最新5件に入らず、Home の未確認一覧だけでは見つからない',
        screens: ['home/unopened-file', 'files/content-rich'],
      },
      recovery: {
        description: '自分のファイル全件へ移り、対象を探し直す',
        screens: ['files/content-rich'],
      },
      next: {
        description: '対象の Viewer へ戻り、共有操作へ進む',
        screens: ['viewer/default'],
      },
    }),
  },
  {
    id: 'share-file-link',
    title: 'ファイルの共有リンクを相手へ渡す',
    persona: 'ai-native-poster',
    actor: '投稿済みファイルをレビューしてもらいたい所有者',
    startingSituation: 'Viewer で共有対象のファイルを確認している',
    prerequisite: '共有対象と、意図した公開範囲が決まっている',
    goal: '意図した相手が開ける共有リンクを取得する',
    completion: '共有リンクを取得し、相手へ渡せる',
    confirmation: 'コピーまたは共有操作の成功と、現在の公開範囲を確認できる',
    loopStage: 'share',
    metric: '投稿済みファイルから共有操作へ進む割合',
    flow: flow({
      start: {
        description: 'Viewer で対象ファイルと公開範囲を確認する',
        screens: ['viewer/default'],
      },
      action: {
        description: '共有操作を選び、リンクを取得する',
        screens: ['viewer/default'],
      },
      pending: {
        description: '共有設定またはリンク取得の完了を待つ',
        screens: ['viewer/default'],
      },
      success: {
        description: '共有リンクが取得され、相手へ渡せる',
        screens: ['viewer/default'],
      },
      failure: {
        description:
          'クリップボードへのコピーに失敗し、手動コピー用の URL が表示される',
        screens: ['viewer/default'],
      },
      recovery: {
        description: '共有ガイドで公開範囲を確認してからやり直す',
        screens: ['guides-link-sharing/default', 'viewer/default'],
      },
      next: {
        description: '相手の閲覧や反応を待つ',
        screens: ['home/default'],
      },
    }),
  },
  {
    id: 'open-received-file',
    title: '受け取った共有リンクからファイルを読む',
    persona: 'link-receiver',
    actor: 'Artifact Share の共有リンクを受け取った閲覧者',
    startingSituation: '相手からファイルの共有リンクが届いている',
    prerequisite: 'リンクが有効で、必要な場合はアクセス権を持っている',
    goal: '共有された内容と作成者の意図を確認する',
    completion: 'Viewer でファイル本文を読める',
    confirmation: 'タイトル、本文、作成者、現在の版を確認できる',
    loopStage: 'view',
    metric: '有効な共有リンクを開いた閲覧者の内容到達率',
    flow: flow({
      start: {
        description: '受け取った共有リンクを開く',
        screens: ['viewer/anonymous'],
      },
      action: {
        description: '必要ならログインし、閲覧を続ける',
        screens: ['sign-in/with-purpose', 'viewer/default'],
      },
      pending: {
        description: '認証または Viewer の読み込みを待つ',
        screens: ['sign-in/with-purpose', 'viewer/default'],
      },
      success: {
        description: '共有されたファイルの内容を読める',
        screens: ['viewer/default'],
      },
      failure: {
        description: 'アカウント不一致またはアクセス不足で閲覧できない',
        screens: ['sign-in/account-not-linked'],
      },
      recovery: {
        description:
          '正しいアカウントでログインするか、所有者へ共有範囲の確認を依頼する',
        screens: ['sign-in/default'],
      },
      next: {
        description: '内容に対するコメントまたは返信へ進む',
        screens: ['viewer/comments-open'],
      },
    }),
  },
  {
    id: 'comment-on-file',
    title: '共有されたファイルへコメントする',
    persona: 'team-collaborator',
    actor: 'ファイルの内容へ具体的な反応を返したい閲覧者',
    startingSituation: 'Viewer で対象ファイルを読んでいる',
    prerequisite: 'コメント可能な権限があり、伝える内容が決まっている',
    goal: '対象ファイルへコメントを残し、所有者へ反応を返す',
    completion: '投稿したコメントが対象ファイルのパネルに表示される',
    confirmation: '自分のコメント本文と投稿時刻を確認できる',
    loopStage: 'react',
    metric: '閲覧からコメント投稿へ進む割合',
    flow: flow({
      start: {
        description: 'Viewer のコメントパネルを開く',
        screens: ['viewer/comments-open'],
      },
      action: {
        description: 'コメントを入力して投稿する',
        screens: ['viewer/comments-open'],
      },
      pending: {
        description: 'コメントの送信完了を待つ',
        screens: ['viewer/comments-open'],
      },
      success: {
        description: '新しいコメントがパネルに表示される',
        screens: ['viewer/comments-open'],
      },
      failure: {
        description: '送信に失敗し、コメントが表示されない',
        screens: ['viewer/comments-open'],
      },
      recovery: {
        description: '入力内容を保持したまま再送するか、権限を確認する',
        screens: ['viewer/comments-open'],
      },
      next: {
        description: '返信またはファイルの更新を待つ',
        screens: ['viewer/comments-open'],
      },
    }),
  },
  {
    id: 'start-own-use-after-viewing',
    title: '受け取ったファイルの閲覧から自分の利用を始める',
    persona: 'link-receiver',
    actor: '共有されたファイルを見て自分でも使いたくなった閲覧者',
    startingSituation:
      '共有 URL で受け取ったファイルを閲覧し、製品を知ったばかり',
    prerequisite:
      '有効な共有リンクを閲覧でき、サインアップに使えるアカウントを持っている',
    goal: '閲覧をきっかけに、自分のワークスペースで最初の投稿の準備まで進む',
    completion:
      '自分のワークスペースの Home が表示され、最初の投稿手順を把握している',
    confirmation:
      '自分のアカウントとワークスペースが画面に表示され、次の投稿手順が分かる',
    loopStage: 'publish',
    metric: '共有 URL の閲覧からサインアップへの転換率',
    flow: flow({
      start: {
        description: '閲覧中のファイルから製品の説明と利用開始の入口を見つける',
        screens: ['viewer/anonymous', 'viewer/intro-open'],
      },
      action: {
        description: 'サインアップして自分のワークスペースを開く',
        screens: ['sign-in/with-purpose', 'start/default'],
      },
      pending: {
        description: '認証とワークスペースの準備を待つ',
        screens: ['sign-in/with-purpose'],
      },
      success: {
        description: '自分の Home が開き、最初の投稿へ進める',
        screens: ['home/empty'],
      },
      failure: {
        description:
          '利用開始の入口や自分での使い方が分からず、閲覧だけで離脱する',
        screens: ['viewer/default', 'sign-in/default'],
      },
      recovery: {
        description: '利用開始の案内から投稿手順を確認して進み直す',
        screens: ['start/default'],
      },
      next: {
        description: '最初のファイルを投稿する',
        screens: ['home/empty'],
      },
    }),
  },
  {
    id: 'review-new-reactions',
    title: '投稿後に新しい反応を確認する',
    persona: 'ai-native-poster',
    actor: '共有したファイルへの反応を確認したい投稿者',
    startingSituation: 'ファイルを共有した後で Home に戻ってきた',
    prerequisite: '共有済みファイルに新しいコメントまたは活動がある',
    goal: '新しい反応の対象と内容を特定する',
    completion: '対象ファイルの新しいコメントを Viewer で確認できる',
    confirmation: '新着表示とコメント本文から未確認だった反応を識別できる',
    loopStage: 'react',
    metric: '新しい反応がある投稿者の反応確認率',
    flow: flow({
      start: {
        description: 'Home で新しい反応の手がかりを探す',
        screens: ['home/default'],
      },
      action: {
        description: '対象ファイルを開き、コメントパネルを確認する',
        screens: ['viewer/comments-open'],
      },
      pending: {
        description: 'Viewer とコメントの読み込みを待つ',
        screens: ['viewer/comments-open'],
      },
      success: {
        description: '前回確認後のコメント内容を特定できる',
        screens: ['viewer/comments-open'],
      },
      failure: {
        description: 'どのファイルに新しい反応があるか分からない',
        screens: ['home/default'],
      },
      recovery: {
        description: '最近見た一覧の未読表示から対象を探し直す',
        screens: ['recent/unread-comments'],
      },
      next: {
        description: 'コメントへ返信するか、指摘を反映した版を投稿する',
        screens: ['viewer/comments-open'],
      },
    }),
  },
  {
    id: 'republish-updated-file',
    title: '同じ共有リンクで更新版を再投稿する',
    persona: 'ai-native-poster',
    actor: '反応を反映した更新版を共有したい投稿者',
    startingSituation: '共有済みファイルをローカルで更新した',
    prerequisite:
      '更新対象を識別する安定キーまたは既存ファイルの情報を持っている',
    goal: '既存の共有先を保ったまま新しい版を投稿する',
    completion: '同じファイルの新しい版が Viewer に表示される',
    confirmation: 'Viewer の版表示と更新後の本文から再投稿の成功を判断できる',
    loopStage: 'republish',
    metric: '反応確認後に同じ共有先へ更新版を投稿する割合',
    flow: flow({
      start: {
        description: '既存ファイルと更新内容を確認する',
        screens: ['viewer/default'],
      },
      action: {
        description: '同じ対象を指定して更新版を投稿する',
        screens: ['guides-cli/default'],
      },
      pending: {
        description: '更新版の処理と Viewer への反映を待つ',
        screens: ['viewer/updated-return'],
      },
      success: {
        description: '新しい版と更新内容を確認できる',
        screens: ['viewer/updated-return', 'viewer/updated-version-menu'],
      },
      failure: {
        description: '別ファイルとして投稿された、または更新結果を確認できない',
        screens: ['files/content-rich'],
      },
      recovery: {
        description: '対象指定と投稿手順を確認し、正しい対象へ再投稿する',
        screens: ['guides-cli/default', 'files/content-rich'],
      },
      next: {
        description: '更新版を共有し、次の反応を待つ',
        screens: ['viewer/updated-return'],
      },
    }),
  },
  {
    id: 'organize-file-in-project',
    title: '投稿済みファイルをプロジェクトへ整理する',
    persona: 'ai-native-poster',
    actor: '投稿済みファイルをチームの仕事単位へ整理したい所有者',
    startingSituation: '自分のファイル一覧に整理前のファイルがある',
    prerequisite: '移動先のプロジェクトと、その共有範囲を理解している',
    goal: '対象ファイルを意図したプロジェクトへ移す',
    completion: 'プロジェクト詳細に対象ファイルが表示される',
    confirmation: 'ファイルの保存先表示とプロジェクトの一覧が一致する',
    loopStage: 'share',
    metric: '投稿済みファイルが意図したプロジェクトへ整理される割合',
    flow: flow({
      start: {
        description: '自分のファイル一覧から対象を探す',
        screens: ['files/content-rich'],
      },
      action: {
        description: '移動先のプロジェクトを選んで移動する',
        screens: ['projects/with-membership', 'files/content-rich'],
      },
      pending: {
        description: '移動処理の完了を待つ',
        screens: ['files/content-rich'],
      },
      success: {
        description: 'プロジェクト詳細に対象ファイルが表示される',
        screens: ['project-detail/with-files'],
      },
      failure: {
        description: '対象または移動先が見つからず整理できない',
        screens: ['files/content-rich', 'projects/empty'],
      },
      recovery: {
        description: 'プロジェクトを作成または選び直して再実行する',
        screens: ['projects/default', 'files/content-rich'],
      },
      next: {
        description: 'プロジェクトの関係者へファイルを共有する',
        screens: ['project-detail/with-files'],
      },
    }),
  },
  {
    id: 'find-project-file',
    title: 'プロジェクトから必要なファイルを見つける',
    persona: 'team-collaborator',
    actor: 'チームのプロジェクトに参加している利用者',
    startingSituation: 'プロジェクト内のファイルを確認する必要がある',
    prerequisite: '対象プロジェクトの閲覧権限を持っている',
    goal: 'プロジェクトの文脈から目的のファイルを見つけて読む',
    completion: '目的のファイルが Viewer で表示されている',
    confirmation:
      'プロジェクト名、ファイル名、本文から目的の対象だと判断できる',
    loopStage: 'view',
    metric: 'プロジェクト訪問から目的のファイルへ到達する割合',
    flow: flow({
      start: {
        description: '参加中のプロジェクトを一覧から選ぶ',
        screens: ['projects/with-membership'],
      },
      action: {
        description: 'プロジェクト内のファイルを探して開く',
        screens: ['project-detail/with-files', 'project-files/with-files'],
      },
      pending: {
        description: 'ファイル一覧または Viewer の読み込みを待つ',
        screens: ['project-files/with-files', 'viewer/default'],
      },
      success: {
        description: '目的のファイルの内容を確認できる',
        screens: ['viewer/default'],
      },
      failure: {
        description: 'プロジェクトまたは目的のファイルを特定できない',
        screens: ['projects/empty', 'project-detail/empty'],
      },
      recovery: {
        description: '参加状況を確認し、全件一覧から探し直す',
        screens: ['projects/with-membership', 'project-files/with-files'],
      },
      next: {
        description: '内容を確認し、コメントまたは共有へ進む',
        screens: ['viewer/comments-open'],
      },
    }),
  },
  {
    id: 'recover-interrupted-publish',
    title: '認証や投稿の失敗から復帰して投稿を完了する',
    persona: 'ai-native-poster',
    actor: 'エージェント経由の投稿を始めたが途中で完了できなかった利用者',
    startingSituation: '認証、ネットワーク、入力のいずれかで投稿が止まっている',
    prerequisite: '元のファイルを保持しており、投稿を再実行できる',
    goal: '失敗理由を理解し、入力や認証を直して投稿を完了する',
    completion: '再実行した投稿が Home と Viewer に反映される',
    confirmation: '成功結果、共有リンク、投稿した内容を画面で確認できる',
    loopStage: 'publish',
    metric: '投稿失敗後に再試行して完了する割合',
    flow: flow({
      start: {
        description: '投稿失敗の結果と再実行可能な元ファイルを確認する',
        screens: ['guides-cli/default'],
      },
      action: {
        description: '案内に従って認証または入力を修正し、再投稿する',
        screens: ['device/with-code', 'sign-in/with-purpose'],
      },
      pending: {
        description: '再認証または再投稿の完了を待つ',
        screens: ['device/with-code'],
      },
      success: {
        description: 'Home と Viewer で投稿結果を確認できる',
        screens: ['home/first-file', 'viewer/default'],
      },
      failure: {
        description: '同じ理由で再び失敗する、または別のアカウントへ接続される',
        screens: ['sign-in/account-not-linked', 'home/empty'],
      },
      recovery: {
        description: '失敗理由と利用アカウントを確認し、手順の先頭からやり直す',
        screens: ['guides-cli/default', 'sign-in/default'],
      },
      next: {
        description: '投稿したファイルを開いて共有する',
        screens: ['viewer/default'],
      },
    }),
  },
]
