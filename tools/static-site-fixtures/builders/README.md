# Static Site Fixture Builders

このディレクトリには、Artifact Share が受け付けるビルド済みサイト一式を再生成するための最小アプリを置く。各アプリは、公式の初期テンプレートに近い見た目とファイル構成を保つ。

## 種類

- `react-spa`: Vite で作る React SPA。`dist/` 相当を `fixtures/static-sites/react-spa/` に出力する。
- `react-router-prerender`: React Router v7 の `ssr: false` と `prerender` で作る事前生成出力。`build/client` を `fixtures/static-sites/react-router-prerender/` にコピーする。
- `next-export`: Next.js の `output: 'export'` で作る静的書き出し。`out/` を `fixtures/static-sites/next-export/` にコピーする。

## 再生成

```bash
pnpm fixtures:build
```

生成済みの `fixtures/static-sites/` は、アップロード処理と sandbox worker の回帰テストで使う。builder 配下の `.next`、`build`、`out` は一時出力なので commit しない。

Artifact Share はビルドサービスではない。fixture builder は、このリポジトリ内で検証用出力を追従生成するためだけに使う。
