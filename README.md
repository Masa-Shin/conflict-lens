# Conflict Lens

ソースコード上でコンフリクトしそうな箇所を自動検知する VS Code 拡張

リモートのベースブランチを定期チェックし、現在開いているファイルが変更されていたら該当行をハイライトします。

<< ここに画像を入れる >>

また、編集時には実際にコンフリクトが起こるかをチェックし、起こる場合は赤くハイライトします。

<< ここに画像を入れる >>

これらにより、
- コンフリクトの危険があるコードを開発中にシームレスに検知
- 他の開発者との修正方針のバッティングを事前検知
を可能にします。

## 目次

- [機能](#機能)
- [要件](#要件)
- [インストール](#インストール)
- [使い方](#使い方)
- [設定リファレンス](#設定リファレンス)
- [コマンドリファレンス](#コマンドリファレンス)
- [トラブルシューティング](#トラブルシューティング)
- [既知の制限](#既知の制限)
- [開発](#開発)
- [ライセンス](#ライセンス)

## 機能

### ベースブランチにおける修正の可視化

リモートのベースブランチを定期チェックし、リモートで変更が入った行があればエディタ上で黄色にハイライトします。

<< 画像 >>

デフォルトでは 5 分ごと、加えて VS Code がフォーカスを取得したタイミングで `git ls-remote` により更新チェックします。
更新があれば、ベースブランチを更新するためのプロンプトを表示します（OK を押すとベースブランチのみ `git fetch`）。

また、ハイライト行のホバーメニューから、リモートでの変更をチェックすることも可能です。

<< 画像 >>

### マージ時のコンフリクトを予測

編集を行うたび、ベースへのマージ時に実際にコンフリクトする行を赤くハイライトします。
また該当ファイルにもバッジを表示します。

<< 画像 >>

## 要件

| | |
|---|---|
| VS Code | 1.74 以上 |
| Git | 2.30 以上 (コンフリクト予測機能は 2.38 以上) |

## インストール

### Marketplace から

<< 公開したら追記 >>

## 使い方

1. git リポジトリを VS Code で開く
2. ステータスバー右下の `Conflict Lens: <baseBranch>`を押下し、ベースブランチを選択する（すでに選択されている場合は不要）

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

<< 画像 >>

衝突が予測されるファイルは上位に並びます。

### 差分エディタで詳細を見る

ハイライトが出ている場合、ベースブランチにおけるコードと、ローカルにおけるコードを左右に並べて比較することが可能です。

<< 画像 >>

起動方法は 2 通りです。

- ハイライトされた行のホバー表示に出る「Open diff」リンクをクリックする
- コマンドパレットから `Conflict Lens: Open Diff` を実行する

### 一時的に無効化

`Conflict Lens: Toggle` でハイライトの on/off を切り替えられます。

## 設定リファレンス

| キー | デフォルト | 範囲 | 説明 |
|---|---|---|---|
| `conflictLens.enabled` | `true` | bool | 拡張全体の on/off |
| `conflictLens.baseBranch` | `origin/main` | string | 比較対象。空で自動検出 |
| `conflictLens.remoteName` | `origin` | string | 自動検出で使うリモート名 |
| `conflictLens.enableConflictPrediction` | `true` | bool | コンフリクト予測を有効にするか |
| `conflictLens.showOverviewRuler` | `true` | bool | スクロールバーにハイライト位置を表示するか |
| `conflictLens.showGutterIcon` | `false` | bool | 行番号横にアイコンを表示するか |
| `conflictLens.showFileDecorationColors` | `false` | bool | Explorer 上でファイル名を色付けするか |
| `conflictLens.showFileDecorationBadges` | `true` | bool | Explorer 上にバッジを表示するか |
| `conflictLens.remoteCheckIntervalMinutes` | `5` | 0-1440 | リモート更新検知の間隔（分）。`0` で無効 |
| `conflictLens.largeFileHunkThreshold` | `200` | 1-10000 | 変更箇所がこの数を超えるファイルは装飾しない |

ハイライトの色や、Explorer のファイル名色は、VS Code の `settings.json` の `workbench.colorCustomizations` で上書きできます。設定可能なキーは次の通りです。

- `conflictLens.changedLineBackground` — ベースが変更した行の背景色（デフォルト黄色）
- `conflictLens.conflictLineBackground` — コンフリクト予測行の背景色（デフォルト赤色）
- `conflictLens.changedFileForeground` — ベースが変更したファイルのファイル名色
- `conflictLens.potentialConflictFileForeground` — コンフリクト予測ファイルのファイル名色

## コマンドリファレンス

| コマンド | 説明 |
|---|---|
| `Conflict Lens: Enable` | 有効化 |
| `Conflict Lens: Disable` | 無効化 |
| `Conflict Lens: Toggle` | 有効/無効を切り替え |
| `Conflict Lens: Refresh` | キャッシュを破棄して再計算 |
| `Conflict Lens: Select Base Branch` | ベースブランチを選択 |
| `Conflict Lens: Show Changed Files` | 変更されたファイル一覧 |
| `Conflict Lens: Open Diff` | 差分エディタを開く |
| `Conflict Lens: Show Output Channel` | ログを表示 |

## トラブルシューティング

`Conflict Lens: Show Output Channel` でログを確認できます。

**ハイライトが出ない**

ステータスバーを確認してください。

- `(no base)` → ベースブランチが未検出。`Select Base Branch` で指定
- `(rebasing)` / `(merging)` → rebase または merge の途中。完了または中止してください
- `(unavailable)` → git が見つからない、または git リポジトリではない

それ以外の場合は、ベースとの差分自体がない可能性があります。次のコマンドで確認できます。

```sh
git log --oneline HEAD...origin/main
```

**コンフリクト予測だけ出ない**

`conflictLens.enableConflictPrediction` が `true` になっているか確認してください。設定が有効でも、ベースブランチが触っていないファイルはコンフリクト予測の対象外です。

**設定を変えたが反映されない**

設定変更は即時反映されるはずですが、それでもおかしい場合は `Conflict Lens: Refresh` を試してください。

## 既知の制限

- マルチルートワークスペースでは最初のフォルダのみ監視
- サブモジュール内のファイル、シンボリックリンクは対象外
- ベースが行った変更箇所が 200 を超えるファイルは装飾されません（閾値は変更可）

## 開発

```sh
npm install
npm test        # vitest
npm run build   # esbuild
```

`F5` で Extension Development Host を起動して動作確認できます。

## ライセンス

MIT
