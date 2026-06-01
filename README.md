# Conflict Lens

ソースコード上でコンフリクトしそうな箇所を自動で検知しハイライトする VS Code 拡張

<< ここに画像を入れる >>

## 機能

### 弱ハイライト：ベース側の変更を可視化

ベースブランチが変更した行をエディタ上で黄色く表示します。`git diff --merge-base` を頭の中で常時走らせる必要がなくなります。

- 行背景に黄色 + ガターに縦棒アイコン
- 編集中バッファに追従（未保存の編集も正しい行に乗ります）
- ホバーで比較対象のブランチ名

### 強ハイライト：マージ時の衝突を予測

`git merge-file -p --diff3` で 3-way 試行マージを実行し、衝突する行を赤く表示します。PR を開いたりマージを試したりする前に衝突箇所が分かります。

- 行背景に赤 + ガターに三角アイコン
- 弱ハイライトより優先（同じ行に両方かかる場合は赤のみ）
- 編集中バッファを `ours` として扱うので、未保存の編集による衝突も検知

### Explorer のファイル装飾

ファイルツリー上で衝突しそうなファイルが一目でわかります。

- ファイル名の色付け（変更あり / 衝突予測の 2 色）
- バッジ表示（`Δ` / `!`）
- 親フォルダにも伝播

### リモート更新の自動検知

設定した間隔（デフォルト 5 分）でリモートを確認し、ベースブランチが進んでいたら通知または自動 fetch します。

## 要件

| | |
|---|---|
| VS Code | 1.74 以上 |
| Git | 2.30 以上 |

## インストール

### Marketplace から

将来公開予定です。

### VSIX をビルドしてインストール

```sh
git clone <this-repo-url> conflict-lens
cd conflict-lens
npm install
npm run build:prod
npx @vscode/vsce package
code --install-extension conflict-lens-*.vsix
```

## 使い方

1. git リポジトリを VS Code で開く
2. ステータスバー右下に `Conflict Lens: <baseBranch>` が表示されることを確認する
3. 必要であれば `Cmd+Shift+P → Conflict Lens: Select Base Branch` でベースブランチを切り替える
4. ファイルを開くと弱・強ハイライトが自動で表示される

### ベースブランチの自動検出

`conflictLens.baseBranch` 設定が空の場合、次の順序で自動検出します。

1. `refs/remotes/origin/HEAD` のシンボリック参照
2. `origin/main`
3. `origin/master`

検出できなかった場合は `(no base)` 表示と通知が出ます。

### 変更されたファイル一覧を見る

`Conflict Lens: Show Changed Files` でベースが変更したファイル一覧を QuickPick で表示できます。衝突予測のあるファイルは上位に並びます。

### 差分エディタで詳細を見る

`Conflict Lens: Open Diff` で、開いているファイルの `merge-base 時点 ↔ 現在のバッファ` 差分を VS Code の差分エディタで開きます。

### 一時的に無効化

`Conflict Lens: Toggle` で全装飾の on/off を切り替えられます。

## 設定リファレンス

| キー | デフォルト | 範囲 | 説明 |
|---|---|---|---|
| `conflictLens.enabled` | `true` | bool | 拡張全体の on/off |
| `conflictLens.baseBranch` | `origin/main` | string | 比較対象。空で自動検出 |
| `conflictLens.enableConflictPrediction` | `true` | bool | 強ハイライトの on/off |
| `conflictLens.showOverviewRuler` | `true` | bool | スクロールバーのマーカー |
| `conflictLens.showGutterIcon` | `true` | bool | 行番号横のガターアイコン |
| `conflictLens.showFileDecorationColors` | `true` | bool | Explorer のファイル名色付け |
| `conflictLens.showFileDecorationBadges` | `true` | bool | Explorer のバッジ表示 |
| `conflictLens.remoteCheckIntervalMinutes` | `5` | 0-1440 | リモート更新検知の間隔（分）。`0` で無効 |
| `conflictLens.autoFetchOnRemoteUpdate` | `false` | bool | リモートが進んだら自動 fetch |
| `conflictLens.largeFileHunkThreshold` | `200` | 1-10000 | この hunk 数を超えると装飾しない |

設定変更は即時反映されます（リロード不要）。

色は `workbench.colorCustomizations` でカスタマイズできます（`conflictLens.changedLineBackground` など）。

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
- `(rebasing)` / `(merging)` → リポジトリが中断状態。完了させてください
- `(unavailable)` → git が見つからない、または git リポジトリではない

それ以外の場合は、ベースとの差分自体がない可能性があります。次のコマンドで確認できます。

```sh
git log --oneline HEAD...origin/main
```

**強ハイライトだけ出ない**

`conflictLens.enableConflictPrediction` が `true` になっているか確認してください。設定が有効でも、ベースブランチが触っていないファイルは強ハイライトの対象外です。

**設定を変えたが反映されない**

設定変更は即時反映されますが、それでもおかしい場合は `Conflict Lens: Refresh` を試してください。

## 既知の制限

- マルチルートワークスペースでは最初のフォルダのみ監視
- サブモジュール内のファイル、シンボリックリンクは対象外
- ベースが 200 hunks を超える変更をしているファイルは装飾しません（閾値は変更可）

## 開発

```sh
npm install
npm test        # vitest
npm run build   # esbuild
```

`F5` で Extension Development Host を起動して動作確認できます。

## ライセンス

MIT
