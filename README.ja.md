# Conflict Lens

[English](README.md) | 日本語

[![VS Marketplace Version](https://vsmarketplacebadges.dev/version-short/Masa-Shin.conflict-lens.png)](https://marketplace.visualstudio.com/items?itemName=Masa-Shin.conflict-lens)
[![CI](https://github.com/Masa-Shin/conflict-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Masa-Shin/conflict-lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

編集するとベースブランチとコンフリクトしうる箇所をハイライトする VS Code 拡張

リモートのベースブランチを定期チェックし、ベースブランチで変更されているコードをハイライトします。

![Conflict Lens の動作画面](media/conflict-highlight.png)

ベースブランチとの diff をその場で確認することも可能です。

![ベースブランチとの差分表示](media/base-diff.png)

- コンフリクトの危険があるコードを開発中にシームレスに検知
- 他の開発者との修正方針のバッティングを事前検知
- 実際のコンフリクトもシミュレート表示可能

## 目次

- [機能](#機能)
- [要件](#要件)
- [インストール](#インストール)
- [使い方](#使い方)
- [その他の機能](#その他の機能)
- [設定リファレンス](#設定リファレンス)
- [コマンドリファレンス](#コマンドリファレンス)
- [トラブルシューティング](#トラブルシューティング)
- [既知の制限](#既知の制限)
- [開発](#開発)
- [ライセンス](#ライセンス)

## 機能

### ベースブランチにおける修正の可視化

リモートのベースブランチを定期チェックし、リモートで変更が入った行があればハイライトします。

デフォルトでは 5 分ごとに（あるいはファイルにフォーカスしたタイミングで）`git ls-remote`を行い更新をチェックします。
更新があれば、ベースブランチを更新するためのプロンプトを表示します（OK を押すとベースブランチのみ `git fetch`）。

![変更行のハイライト](media/highlight-changed-lines.png)

また、ハイライト行のホバーメニューから、リモートにおける変更をチェックすることも可能です。

![ホバーメニューからリモートの変更を確認](media/hover-remote-check.png)

## 要件

- VS Code 1.74 以上
- Git 2.30 以上

## インストール

### Marketplace から

1. VS Code の拡張機能ビューを開く（`Cmd`/`Ctrl` + `Shift` + `X`）
2. 「Conflict Lens」で検索
3. インストールを押す

コマンドラインからも入れられます。

```sh
code --install-extension Masa-Shin.conflict-lens
```

[Marketplace のページ](https://marketplace.visualstudio.com/items?itemName=Masa-Shin.conflict-lens)から直接開くこともできます。

## 使い方

1. git リポジトリを VS Code で開く
2. ステータスバー右下の `Conflict Lens` を押下し、ベースブランチを選択する（すでに選択されている場合は不要）

これで各種機能が有効化されます。

### ベースブランチの自動検出機能について

拡張機能をインストール時、ベースブランチを次の順序で自動検出します。

1. リモートのデフォルトブランチ（`refs/remotes/<remoteName>/HEAD` の参照先）
2. `<remoteName>/main`
3. `<remoteName>/master`

検出できなかった場合は `(no base)` と表示され、各種機能が無効化されます。

## その他の機能

### 変更されたファイル一覧を見る

`Conflict Lens: Show Changed Files` を実行すると、ベースブランチで変更されたファイルが画面上部に一覧表示され、選択するとそのファイルが開きます。

### 差分エディタで詳細を見る

ベースブランチでの現在の内容と、自分のローカルの内容を左右に並べて比較できます。

起動方法:

- ハイライトされた行のホバーメニューから「Show base changes」リンクをクリック
- コマンドパレットから `Conflict Lens: Show Base Branch Changes` を実行

### コンフリクトの内容を確認する

想定されるコンフリクトの内容を、別タブで開いて確認できます。コンフリクトしない場合は「衝突しません」と通知します。

![コンフリクトのプレビュー](media/preview-conflict.png)

起動方法:

- ハイライトされた行のホバーメニューから「Preview conflict」リンクをクリック
- コマンドパレットから `Conflict Lens: Preview Conflict` を実行

### 一時的に無効化

`Conflict Lens: Toggle` でハイライトの on/off を切り替えられます。

### AI エージェントと連携する

ハイライト情報は、MCP サーバを通じて AI エージェントに渡すことができます。

AI がコンフリクトを気にせず編集してしまう場合に有効です。

#### 利用方法

Claude Code の場合:

1. コマンドパレットで `Conflict Lens: Copy Claude Code MCP Registration Command` を実行する。登録用コマンドがクリップボードにコピーされます。
2. ターミナルに貼り付けて実行する。

Claude Code 以外のツールを使う場合は、そのツールの MCP サーバの起動コマンドに `node <拡張のパス>/dist/mcp-server.js` を指定してください。

※ MCP クライアントなら何でも使えるはずですが、Claude Code以外での動作確認はしていません。

## 設定リファレンス

| キー | デフォルト | 範囲 | 説明 |
|---|---|---|---|
| `conflictLens.enabled` | `true` | bool | 拡張全体の on/off |
| `conflictLens.remoteName` | `origin` | string | 自動検出で使うリモート名 |
| `conflictLens.showOverviewRuler` | `true` | bool | スクロールバーにハイライト位置を表示するか |
| `conflictLens.showFileDecorationBadges` | `true` | bool | Explorer 上にバッジを表示するか |
| `conflictLens.remoteCheckIntervalMinutes` | `5` | 0-1440 | リモート更新検知の間隔（分）。`0` で無効 |
| `conflictLens.mcp.enabled` | `true` | bool | AI エージェントと連携可能にする |

ハイライトの色は、VS Code の `settings.json` の `workbench.colorCustomizations` で上書きできます。設定可能なキーは次の通りです。

- `conflictLens.changedLineBackground` — ベースが変更した行の背景色（デフォルト黄色）

## コマンドリファレンス

| コマンド | 説明 |
|---|---|
| `Conflict Lens: Enable` | 有効化 |
| `Conflict Lens: Disable` | 無効化 |
| `Conflict Lens: Toggle` | 有効/無効を切り替え |
| `Conflict Lens: Refresh` | キャッシュを破棄して再計算 |
| `Conflict Lens: Select Base Branch` | ベースブランチを選択 |
| `Conflict Lens: Show Changed Files` | 変更されたファイル一覧 |
| `Conflict Lens: Show Base Branch Changes` | 現在のファイルとベースブランチの差分を表示 |
| `Conflict Lens: Preview Conflict` | 予想されるコンフリクトを読み取り専用のプレビューで表示 |
| `Conflict Lens: Show Output Channel` | ログを表示 |
| `Conflict Lens: Copy Claude Code MCP Registration Command` | Claude Code にMCPを登録するコマンドをコピー |


## トラブルシューティング

`Conflict Lens: Show Output Channel` でログを確認できます。

**ハイライトが出ない**

機能が止まっているときは、ステータスバーの `Conflict Lens` に打ち消し線が付きます。理由はその項目にマウスを乗せると表示されます。

- ベースブランチが未検出 → `Select Base Branch` で指定
- rebase または merge の途中 → 完了または中止してください
- どのブランチにもいない状態（detached HEAD）→ この状態で作業することは通例ないため停止中。ブランチをチェックアウトすると再開します
- git が見つからない、または git リポジトリではない

打ち消し線が付いていないのにハイライトが出ない場合は、ベースとの差分自体がない可能性があります。次のコマンドで確認できます。

```sh
git log --oneline HEAD...origin/main
```

**設定を変えたが反映されない**

設定変更は即時反映されるはずですが、それでもおかしい場合は `Conflict Lens: Refresh` を試してください。

## 既知の制限

- マルチルートワークスペースでは最初のフォルダのみ監視
- サブモジュール内のファイル、シンボリックリンクは対象外
- 非常に大きいファイル（1 万 5 千行、または約 150 万文字を超えるもの）はハイライト対象外

## 開発

### 開発環境の構築

以下を実行すると、ビルドした拡張機能を読み込んだ状態の VSCode が別ウィンドウで立ち上がり、動作確認ができます。

```sh
npm run dev
```

## ライセンス

MIT
