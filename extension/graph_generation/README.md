# Graph generation

How LLM-IDE gets its graphs, and how to supply a different engine.

## 概要

グラフ生成は**着脱可能**です。グラフを *読む・描く* 部分は常にアプリに存在し、
グラフを *作る* 部分（スキャナ・抽出器・メモリ生成器）はプラグインで差し替えられます。

エンジンを外してもアプリはビルドでき、既にディスクにある `graph.json` は描画され続けます。
生成だけが止まります。

## 責務の分割

| レイヤ | 場所 | 着脱 |
|---|---|---|
| 正規モデル + JSON 契約 + 成果物レンダリング | `mac/LocalPackages/graph-kit/Sources/GraphCore/Model/` | 常在 |
| レイアウトエンジン | `mac/LocalPackages/graph-kit/Sources/GraphCore/Layout/` | 常在 |
| 描画（Canvas / 3D / パレット） | `mac/Sources/LlmIdeMac/Graph/Views/` | 常在 |
| エンジン境界 | `mac/Sources/LlmIdeMac/Graph/Engine/` | 常在 |
| merge / InfiniteBrain 生成 | `mac/LocalPackages/graph-kit/Sources/GraphKit/` | **着脱可** |
| **生成器（スキャナ・抽出器）** | `mac/LocalPackages/graph-kit/` | **着脱可** |

レイアウトを常在の `GraphCore` プロダクトに置いているのが要点です。エンジン側に置くと、外した瞬間に
Graph ビューが真っ白になり「不要なら外す」が成立しません。

## 契約

アプリが期待するのは、`mac/Sources/LlmIdeMac/Graph/Engine/GraphEngine.swift` の
`GraphEngine` プロトコルだけです。

```swift
func scanCode(repoRoot: URL) async throws -> CodeScan
func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory
func generateDocMemory(files: [URL]) async throws -> GeneratedMemory
func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData
func docSetFingerprint(roots: [URL]) -> String
```

実装は2つあります。

- **`BuiltinGraphEngine`** — `graph-kit` を直接呼ぶコンパイル時エンジン。
  **アプリ内で `import GraphKit` しているのはこのファイルだけ**です。
- **`PluginGraphEngine`** — サブプロセスを起動し、正規 JSON を読むランタイムエンジン。

## プラグインとしてエンジンを供給する

プラグインのルートに `graph-engine.json` を置くと、
`GraphEngineLocator` が起動時に発見します。

```json
{
  "schemaVersion": 1,
  "name": "graph-kit",
  "displayName": "GraphKit",
  "docExtensions": ["md", "mdx", "markdown", "txt"],
  "commands": {
    "scanCode":  { "command": "node", "args": ["dist/cli.js", "code", "{repo}", "--out", "{out}"] },
    "docMemory": { "command": "node", "args": ["dist/cli.js", "memory", "{roots}", "--out", "{out}"] },
    "merge":     { "command": "node", "args": ["dist/cli.js", "merge", "--code", "{code}", "--doc", "{doc}", "--chunks", "{chunks}", "--out", "{out}"] }
  }
}
```

プレースホルダは実行時に置換されます。

| プレースホルダ | 意味 |
|---|---|
| `{repo}` | 走査対象リポジトリの絶対パス |
| `{roots}` | 文書ルートの絶対パス。`:` 区切り |
| `{code}` `{doc}` `{chunks}` | `merge` への入力 JSON のパス |
| `{out}` | **出力先。コマンドはここに正規 JSON を書くこと** |

契約が**サブプロセス + 正規 JSON** である理由は、エンジンの実装言語をエンジン自身の
問題に留めるためです。Node CLI でも Python スクリプトでもコンパイル済みバイナリでも
アプリ側は区別しません。ワイヤ形式は既存の
[`graph-kit/schema/graph.schema.json`](../../mac/LocalPackages/graph-kit/schema/graph.schema.json)
です。

### 出力形式

`scanCode` は正規グラフドキュメントを書きます。`docMemory` はそれに2つのキーを足します。

```json
{
  "schemaVersion": 1,
  "nodes": [...], "edges": [...], "layers": [], "tour": [],
  "chunks": [...],
  "docCount": 13
}
```

`chunks` は必須ではありませんが、**無いと doc→code のクロスリンクが作れません**
（リンク解決はチャンク本文中のインラインコード参照を見るため）。

`chunks` のデコードは寛容です。TypeScript 実装は `docURL` ではなく `docPath` を持ち、
`graphOnly` / `relatedModules` を持ちませんが、`MemoryChunk` はどちらも受け付けます
（`CGNode` が `position` / `metadata` の欠落を許すのと同じ方針）。

### `merge` を宣言しない場合

`merge` は任意です。省略すると両トラックの単純な合併になり、
**doc→code のクロスリンクは付きません**。これは機能低下であり同等ではないので、
黙って同一視せずログに記録されます。

## インストール

Library → Plugins → Plugin Marketplace に git URL を入力します。clone は Mac アプリ側で
実行されます（[`PluginGitInstaller.swift`](../../mac/Sources/LlmIdeMac/Services/PluginGitInstaller.swift) /
[`PluginMarketplace.swift`](../../mac/Sources/LlmIdeMac/Services/PluginMarketplace.swift)）。
プラグインは `~/Library/Application Support/llm-ide/plugins/<name>/` に展開されます。

**`llm-sources/` はエンジンのホストに使えません。** あちらは設計上
「discovery-only」で、登録されたリポジトリの hooks も `.mcp.json` も**絶対に実行しません**
（[`llm-sources/registry.mjs`](../llm-sources/registry.mjs) の SAFETY コメント参照）。
skills やドキュメントを届ける用途には使えますが、生成は動きません。

## コンパイル時エンジンを外す

`mac/Package.swift` の2箇所をコメントアウトします（`// UNPLUG:` 印付き）。

1. `.product(name: "GraphKit", package: "graph-kit")`
2. `.define("GRAPHKIT_BUILTIN")`

`.package(path: "LocalPackages/graph-kit")` の行は**残します** — 常在の
`GraphCore` プロダクト（モデル + レイアウト）がこのパッケージから来るためです。

`#if canImport(GraphKit)` ではなく明示的な define を使っています。`canImport` は
`.build` に残った古いモジュールに対しても真を返すため、ビルトインエンジンを
コンパイルに含めた上でリンク時に失敗し、綺麗に縮退しませんでした。

## 既知の未完了事項

- **graph-kit をインストール可能なバンドルとして配布する経路が未整備。**
  `graph-engine.json` のコマンドは `typescript/dist/` を参照しますが、これは
  `npm install && npm run build` の成果物で、リポジトリにコミットされていません。
  プラグイン機構にビルドフックもありません。よってプラグイン*経路*は実装・検証済みですが、
  graph-kit 自体をそのまま git URL から入れて動かすには、`dist/` の事前コミットか
  インストールフックのどちらかが必要です。
- **`merge` コマンドが TypeScript CLI に存在しません。** よって現状プラグイン経由では
  doc→code クロスリンクが付きません（上記の縮退動作）。
- **プラグイン経由では `CodeScan.scan` が空になります。** TypeScript CLI はグラフしか
  出さないため、シンボル一覧を必要とするコード・ノート書き出しは何も書きません
  （誤ったものを書くよりは何も書かない方を選んでいます）。
