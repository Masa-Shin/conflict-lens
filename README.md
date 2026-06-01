# Conflict Lens

ソースコード上でコンフリクトしそうな箇所を自動で検知しハイライトする VS Code 拡張

<< ここに画像を入れる >>
---

## 目次

- [なぜ作ったか](#なぜ作ったか)
- [機能](#機能)
- [要件](#要件)
- [インストール](#インストール)
- [使い方](#使い方)
- [実機検証クイックスタート](#実機検証クイックスタート)
- [機能別検証チェックリスト](#機能別検証チェックリスト)
- [設定リファレンス](#設定リファレンス)
- [コマンドリファレンス](#コマンドリファレンス)
- [ログ / トラブルシューティング](#ログ--トラブルシューティング)
- [既知の制限](#既知の制限)
- [開発者向け](#開発者向け)
- [ライセンス](#ライセンス)

---

## なぜ作ったか

VSCode 標準の Source Control 表示は **自分が編集した行**（HEAD と作業ツリーの差分）しか教えてくれない。

しかし長く動かしてるフィーチャブランチでは、本当に気をつけるべきは **自分の作業期間中に base 側で起きた変更** と、それが **自分の変更とぶつかる箇所**。これは:

- `git fetch origin && git diff --merge-base origin/main` を頭の中で常時走らせる
- PR を開いてみるまで衝突に気付かない
- レビュー前にマージしてみるまで分からない

のいずれかでカバーする必要があった。

Conflict Lens は両方をエディタの中で見えるようにする:

1. **base が変えた行** をエディタ・エクスプローラに黄色で表示（**弱ハイライト**）
2. **自分の編集とぶつかってマージで衝突しそうな行** を赤で表示（**強ハイライト**）

両方とも編集中バッファに追従するので、未保存の編集を含めて常に正しい行に出る。

### git の標準機能との関係

| | 標準の git/VSCode | Conflict Lens |
|---|---|---|
| 自分が編集した行 | ✓（Source Control） | （対象外） |
| base が変えた行 | `git diff --merge-base` を手動実行 | **常時可視化（黄色）** |
| マージで衝突する行 | merge してみるまで分からない | **常時予測（赤）** |
| リモート更新の検知 | 手動 fetch | **定期チェック + 通知/auto-fetch** |
| ファイル単位の俯瞰 | なし | **Explorer の色 + バッジ** |

---

## 機能

### 弱ハイライト：ベース側の変更

`git diff --merge-base HEAD <base>` の結果を行レベルで可視化。

- 行の背景に黄色
- 行番号横にゴールドの縦棒
- 右端スクロールバー（オーバービュールーラー）にもマーカー
- ホバーで `Changed relative to origin/main`

**バッファ追従**: 編集中のファイルでも、行を追加 / 削除するとハイライト位置が追従する。未保存の状態でも正しい行に乗る。

### 強ハイライト：衝突予測

`git merge-file -p --diff3` で 3-way 試行マージを実行し、`<<<<<<<` / `=======` / `>>>>>>>` マーカーが出る場所を行範囲に変換。

- 行の背景に赤
- 行番号横に赤い三角アイコン
- 弱ハイライトより**優先**（同じ行に両方かかる場合は黄色を抑止して赤だけ）
- ホバーで `Will conflict when merging origin/main`

`ours = 現在のバッファ` で試行するので、未保存の編集も衝突予測に反映される。

### ファイル装飾（Explorer）

ファイルツリー側でも一目で:

- 色: `conflictLens.changedFileForeground` / `conflictLens.potentialConflictFileForeground`（カスタマイズ可）
- バッジ: `Δ`（変更）/ `!`（衝突予測）
- 親フォルダにも伝播（中に該当ファイルがあるとフォルダにもバッジ）
- ホバーで詳細

### リモート更新検知

定期的（デフォルト 5 分）に `git ls-remote` で base ブランチのリモート側を確認し、ローカルの追跡 ref より進んでいたら:

- **通知モード**（デフォルト）: `origin/main has moved upstream` 通知 + `Fetch now` ボタン
- **自動 fetch モード**（`autoFetchOnRemoteUpdate=true`）: 通知せず自動 fetch → ハイライト再計算

同じリモート SHA に対しては再通知しない（重複抑制）。`vscode.git` の `Repository.fetch` を優先使用するので、SSH passphrase / credential helper の UI と統合される。

### 設定で挙動カスタマイズ可

色・バッジの on/off、間隔、閾値などすべて設定で制御できる（[設定リファレンス](#設定リファレンス)）。

### 国際化対応の素地

`package.nls.json` と `l10n/bundle.l10n.json` で全ユーザ向け文字列を分離。日本語など他言語の bundle を後から追加可能。

---

## 要件

| | |
|---|---|
| VSCode | 1.74 以上 |
| Git | 2.30 以上 |
| 拡張依存 | `vscode.git`（VSCode 同梱なので意識不要） |
| ネットワーク | リモート更新検知を使う場合のみ |

```sh
git --version
code --version
```

### Workspace Trust

`Untrusted Workspace` モードでは動作しない（spec §1.1）。git CLI 実行を含むため。

---

## インストール

### A. ソースから（推奨：MVP 段階）

```sh
git clone <this-repo-url> conflict-lens
cd conflict-lens
npm install
npm run build:prod
```

### B. VSIX をビルドしてインストール

```sh
npm install -g @vscode/vsce
vsce package      # conflict-lens-0.0.1.vsix が生成される
code --install-extension conflict-lens-0.0.1.vsix
```

### C. Marketplace（未公開）

将来 `vsce publish` 後に検索可能になる予定。

---

## 使い方

### 1. リポジトリを開く

VSCode で git リポジトリ（`.git/` がある）のフォルダを開く。

### 2. ベースブランチの自動検出を確認

ステータスバー右下に `Conflict Lens: <baseBranch>` が表示される。

自動検出順序:

1. 設定 `conflictLens.baseBranch` の値（あれば）
2. `refs/remotes/origin/HEAD` のシンボリック参照
3. `origin/main`
4. `origin/master`

検出できなかった場合は `(no base)` 表示 + `Select Base Branch` への誘導通知。

### 3. ベースブランチを変えたい場合

コマンドパレット（`Cmd+Shift+P` または `Ctrl+Shift+P`）から:

- **`Conflict Lens: Select Base Branch`** → リモート追跡ブランチの QuickPick

選んだ値は workspace の `conflictLens.baseBranch` 設定に保存される（リポジトリごと）。

### 4. 編集中のハイライトを見る

ファイルを開けば自動的に弱・強ハイライトが計算される。編集すると `~200ms` 後に再計算（debounce）。

### 5. 変更されたファイル一覧を見る

- **`Conflict Lens: Show Changed Files`** → QuickPick。衝突ファイル上位 + `Predicted conflict` ラベル付き

### 6. 差分エディタで詳細を見る

- **`Conflict Lens: Open Diff`** → アクティブなエディタについて、`base 側の内容 ↔ HEAD 側の内容` で VSCode 標準の Diff Editor を開く

### 7. リモート更新が来たら

- 通知が出たら **`Fetch now`** をクリック → vscode.git 経由で fetch → ハイライト自動更新
- 自動 fetch にしたいなら `conflictLens.autoFetchOnRemoteUpdate` を `true` に

### 8. 一時的に無効化したい

- **`Conflict Lens: Toggle`** → 装飾を全部消す
- もう一度 Toggle で戻る
- 個別に `Disable` / `Enable` コマンドもある

### 9. キャッシュをリセットしたい

- **`Conflict Lens: Refresh`** → 全 LRU 破棄 + base 再検出 + 全装飾再計算

### 10. ログを見る

- **`Conflict Lens: Show Output Channel`** → 出力チャンネル

---

## 実機検証クイックスタート

開発版を試したい / 動作確認したい場合の手順。

### 1. リポジトリをクローンしてビルド

```sh
git clone <this-repo-url> conflict-lens
cd conflict-lens
npm install
npm run build
```

### 2. VSCode で開いて Extension Development Host を起動

```sh
code .
```

VSCode が開いたら **`F5`** を押す（または「実行とデバッグ」→「Run Extension」）。

- `.vscode/launch.json` が `preLaunchTask` で `npm run build` を走らせる
- 新しい VSCode ウィンドウ（Extension Development Host）が開き、そのウィンドウに Conflict Lens がロード済みになる

### 3. テスト用 git リポジトリを準備

**重要**: Conflict Lens は「フィーチャブランチがベースから分岐した状態」がないと何も見えない。空のフォルダや mb（マージベース）と同じコミットだけのリポジトリだとハイライトは出ない。

手早く検証フィクスチャを作るスクリプト:

```sh
# 別のターミナルで実行
mkdir /tmp/conflict-lens-demo && cd /tmp/conflict-lens-demo
git init -b main
git config user.email demo@example.com
git config user.name demo

# 共通祖先となる初期コミット
cat > app.js <<'EOF'
function greet(name) {
  return "Hello, " + name;
}

function farewell(name) {
  return "Bye, " + name;
}

module.exports = { greet, farewell };
EOF
git add app.js && git commit -m 'init'

# ローカル「リモート」と origin を作る
cd /tmp && git clone --bare conflict-lens-demo conflict-lens-demo-remote.git
cd conflict-lens-demo
git remote add origin /tmp/conflict-lens-demo-remote.git
git push -u origin main

# feature ブランチを切って自分の変更
git checkout -b feature
sed -i.bak 's/Hello/Hi/' app.js && rm app.js.bak
git commit -aqm 'feature: rename Hello to Hi'

# main を進めて、衝突する変更と独立した変更を入れる
git checkout main
sed -i.bak 's/Hello/Hey/' app.js && rm app.js.bak    # 同じ行を別文字列に → 衝突
sed -i.bak 's/Bye, /See ya, /' app.js && rm app.js.bak # 別の行 → 弱ハイライト
git commit -aqm 'main: greet to Hey, farewell to See ya'
git push origin main

# feature に戻る
git checkout feature
```

### 4. Extension Development Host で開く

Extension Development Host ウィンドウのメニューで `File → Open Folder` → `/tmp/conflict-lens-demo` を選択。

`app.js` を開くと:

- **2 行目（`return "Hi, " + name;`）**: 赤背景 + ガター三角（強ハイライト、衝突予測）
- **6 行目（`return "Bye, " + name;`）**: 黄色背景 + ガター縦棒（弱ハイライト、base が変えた行）
- ステータスバー右下: `Conflict Lens: origin/main`
- Explorer の `app.js`: 赤い名前 + `!` バッジ

---

## 機能別検証チェックリスト

### A. 弱ハイライト

- [ ] `app.js` を開いて、6 行目に黄色背景が出る
- [ ] 行にホバーして `Changed relative to origin/main` ツールチップ表示
- [ ] 設定 `conflictLens.showGutterIcon` を `false` → 縦棒だけ消える
- [ ] 設定 `conflictLens.showOverviewRuler` を `false` → 右端スクロールバーのマーカー消える

### B. 強ハイライト

- [ ] `app.js` の 2 行目に赤背景 + 三角アイコン
- [ ] ホバーで `Will conflict when merging origin/main`
- [ ] 設定 `conflictLens.enableConflictPrediction` を `false` → 赤が消えて弱（黄色）に戻る
- [ ] 同じ行に弱と強が両方かかるケースで **赤だけ** 表示される（黄色は抑止される）

### C. バッファ追従

- [ ] `app.js` の **先頭に空行を 5 行追加** → ハイライトが 5 行下にスライド
- [ ] タイプした瞬間ではなく ~200ms 後に再計算（debounce）
- [ ] 保存しなくても追従する

### D. ファイル装飾

- [ ] Explorer の `app.js` が赤名 + `!`
- [ ] 親フォルダ（`/tmp/conflict-lens-demo`）にも `!` が伝播
- [ ] 設定 `conflictLens.showFileDecorationBadges` を `false` → バッジ消える
- [ ] 設定 `conflictLens.showFileDecorationColors` を `false` → 色だけ消える

### E. コマンド

`Cmd+Shift+P` で:

- [ ] `Conflict Lens: Select Base Branch` → QuickPick でリモート追跡ブランチが出る
- [ ] `Conflict Lens: Show Changed Files` → base が変えたファイル一覧、衝突ファイルは上位 + `Predicted conflict`
- [ ] `Conflict Lens: Open Diff` → 開いてるファイルが `origin/main ↔ app.js` で diff 表示
- [ ] `Conflict Lens: Toggle` → 全装飾の on/off
- [ ] `Conflict Lens: Refresh` → キャッシュ全破棄 + 再計算
- [ ] `Conflict Lens: Enable` / `Disable` → 同じく on/off
- [ ] `Conflict Lens: Show Output Channel` → ログウィンドウ

### F. リモート更新検知

```sh
# 別ターミナルで「他人が main にコミットして push」をシミュレート
cd /tmp
git clone /tmp/conflict-lens-demo-remote.git other-clone
cd other-clone
git config user.email other@example.com
git config user.name other
echo "// additional comment" >> app.js
git add app.js && git commit -m 'other person updated'
git push origin main
```

- [ ] `conflictLens.remoteCheckIntervalMinutes` を `1` にして 1 分待つ
- [ ] 通知 `origin/main has moved upstream. [Fetch now]` が出る
- [ ] `Fetch now` を押すと vscode.git 経由で fetch → ハイライトが新しい base に対して再計算
- [ ] 同じリモート SHA に対しては再通知されない
- [ ] `conflictLens.autoFetchOnRemoteUpdate` を `true` にして再現 → 通知なしに自動 fetch + `fetched updates for origin/main` 表示
- [ ] `conflictLens.remoteCheckIntervalMinutes` を `0` にすると完全に無効

### G. 異常系（劣化なし）

- [ ] **rebase 中** にハイライト消える（`git rebase -i HEAD~1` で `edit` 指定し中断）→ ステータスバーが `(rebasing)`
- [ ] **マージ中** も同様
- [ ] サブモジュール内のファイルは装飾されない（MVP 仕様）
- [ ] シンボリックリンクは装飾されない
- [ ] **マルチルートワークスペース** → 通知「最初のフォルダのみ監視中」が出る

### H. 大きいファイル抑制

```sh
cd /tmp/conflict-lens-demo
git checkout main
seq 1 1000 > big.txt && git add big.txt && git commit -m 'add big'
awk 'NR % 10 == 0 { print "CHANGED-" $0 } NR % 10 != 0 { print }' big.txt > tmp && mv tmp big.txt
git commit -aqm 'many hunks'
```

- [ ] `conflictLens.largeFileHunkThreshold` を `5` に設定
- [ ] `big.txt` を開く → hunks が 5 超えで装飾されない
- [ ] `200` に戻すと装飾再開

---

## 設定リファレンス

| 設定キー | デフォルト | 範囲 | 説明 |
|---|---|---|---|
| `conflictLens.enabled` | `true` | bool | 拡張全体の on/off |
| `conflictLens.baseBranch` | `origin/main` | string | 比較対象。空文字 / 未設定で自動検出 |
| `conflictLens.enableConflictPrediction` | `true` | bool | 強ハイライト（赤）の on/off |
| `conflictLens.showOverviewRuler` | `true` | bool | 右端スクロールバーのマーカー |
| `conflictLens.showGutterIcon` | `true` | bool | 行番号横のガターアイコン |
| `conflictLens.showFileDecorationColors` | `true` | bool | Explorer のファイル名色付け |
| `conflictLens.showFileDecorationBadges` | `true` | bool | Explorer のバッジ（Δ / !） |
| `conflictLens.remoteCheckIntervalMinutes` | `5` | 0-1440 | リモート更新検知間隔。`0` で無効 |
| `conflictLens.autoFetchOnRemoteUpdate` | `false` | bool | リモートが進んだら通知せず自動 fetch |
| `conflictLens.largeFileHunkThreshold` | `200` | 1-10000 | この hunk 数超えで装飾しない |
| `conflictLens.deletedLineMarkerPosition` | `nextLine` | enum | MVP 未配線 |

設定変更は即座に反映（リロード不要）。

### カスタム色

VSCode の `workbench.colorCustomizations` で背景色やファイル色を上書き可能:

```json
{
  "workbench.colorCustomizations": {
    "conflictLens.changedLineBackground": "#ffc80050",
    "conflictLens.conflictLineBackground": "#f14c4c80",
    "conflictLens.changedFileForeground": "#d7ba7d",
    "conflictLens.potentialConflictFileForeground": "#f14c4c"
  }
}
```

---

## コマンドリファレンス

| コマンド ID | 表示名 | 動作 |
|---|---|---|
| `conflictLens.enable` | Enable | `conflictLens.enabled = true` |
| `conflictLens.disable` | Disable | `conflictLens.enabled = false` |
| `conflictLens.toggle` | Toggle | enabled を反転 |
| `conflictLens.refresh` | Refresh | 全キャッシュ破棄 + 再計算 |
| `conflictLens.selectBaseBranch` | Select Base Branch | QuickPick で base を選択 |
| `conflictLens.showChangedFiles` | Show Changed Files | base が変えたファイル一覧 |
| `conflictLens.openDiff` | Open Diff | アクティブファイルの base ↔ HEAD 差分 |
| `conflictLens.showOutputChannel` | Show Output Channel | ログを開く |

---

## ログ / トラブルシューティング

### ログを見る

`Cmd+Shift+P` → `Conflict Lens: Show Output Channel`。

出力例:

```
Conflict Lens activated.
Git 2.39.3 resolved at /usr/local/bin/git (conflict prediction: enabled).
Target repository: /tmp/conflict-lens-demo.
Initial git state: ready.
Base branch resolved: origin/main (auto-detected).
```

`warn` レベルが出ているときは何かしらの計算失敗。

### ハイライトが出ない

1. ステータスバーを確認
   - `(no base)` → ベースブランチが検出できていない。`Select Base Branch` で手動指定
   - `(rebasing)` / `(merging)` → 異常状態。終わらせる
   - `(unavailable)` → git が見つからない / リポジトリじゃない / サブモジュール
2. base と HEAD が同じだとそもそも差分がない:

   ```sh
   git log --oneline HEAD...origin/main
   ```

3. Output Channel に warning が出ていないか
4. `Conflict Lens: Refresh` で全キャッシュ破棄 + 再計算

### 強ハイライトだけ出ない

- `conflictLens.enableConflictPrediction` が `true` か確認
- そのファイルで実際に merge-file が conflict を検出するか手動確認:

  ```sh
  MB=$(git merge-base HEAD origin/main)
  git show HEAD:app.js > /tmp/ours
  git show $MB:app.js > /tmp/base
  git show origin/main:app.js > /tmp/theirs
  git merge-file -p --diff3 /tmp/ours /tmp/base /tmp/theirs
  ```

  これでマーカーが出ないなら衝突しない（強ハイライトの対象外）

### Extension Development Host で再ロード

開発中にコードを変えたら **`Cmd+R`**（Extension Development Host のウィンドウで）でリロード。ソースを変えたらホスト側ターミナルで:

```sh
npm run watch  # ファイル変更で自動再ビルド
```

を起動しておくと楽。

### git の競合フックなどで邪魔されない

`SECURE_ARGS` 経由で `core.hooksPath=/dev/null`, `core.editor=false`, `gpg.program=false` などを強制しているので、git の hooks や GPG 署名で extension が止まることはない。

---

## 既知の制限

- **マルチルートワークスペース**: 最初のフォルダのみ監視
- **サブモジュール**: 検出するが対象外（superproject から開いた場合のみ動作）
- **シンボリックリンク**: セキュリティ上の理由で対象外
- **`deletedLineMarkerPosition`**: 設定だけあって未配線
- **大規模ファイル**: 200 hunks 超で装飾停止（閾値変更可）
- **強ハイライトの精度**: `ours = バッファ` で計算するので、未保存編集を含めた予測 = 実マージ結果とは完全一致しない場合あり（コミット後に差は消える）
- **バイナリファイル**: 装飾は試みるが正常動作未保証
- **CRLF / 混在改行**: 内部で normalize しているが、長期的にエッジケース要監視

---

## 開発者向け

### テスト

```sh
npm test            # vitest run（244 テスト、~2 秒）
npm run typecheck   # tsc --noEmit
```

カバレッジ:
- 純粋なロジック（パーサ、マッピング、LRU、conflict markers、range ops）: 完全
- Git CLI 経由のパイプライン（diff / merge-tree / merge-file / cat-file / ls-remote）: 一時 git リポジトリを使った integration
- Coordinator 層（vscode API 依存）: `test/__mocks__/vscode.ts` 経由でモック化して unit テスト
- `src/extension.ts` 自体: 未テスト（E2E でカバーする想定）

### ビルド

```sh
npm run build        # esbuild、開発用（~100ms）
npm run build:prod   # 本番用 minify あり
npm run watch        # ファイル変更で自動再ビルド
```

### パッケージング

```sh
npm install -g @vscode/vsce
vsce package
```

`conflict-lens-<version>.vsix` ができる。

### コードの読み始め

| ファイル | 役割 |
|---|---|
| `src/extension.ts` | エントリポイント、ライフサイクル、コマンド、タイマー |
| `src/git/runner.ts` | git CLI 起動の共通ハードニング（SECURE_ENV / SECURE_ARGS） |
| `src/git/cat-file-batch.ts` | 永続 `git cat-file --batch` ワーカ（hot path 用） |
| `src/git/diff.ts` | base-side diff の hunks 取得 + merge-base 解決 |
| `src/git/merge-tree.ts` | 衝突ファイル一覧の取得 |
| `src/git/merge-file.ts` | 3-way 試行マージ（tmpfile 経由） |
| `src/git/remote-check.ts` | リモート進行検知 |
| `src/diff/weak-highlight.ts` | 弱ハイライト計算 |
| `src/diff/strong-highlight.ts` | 強ハイライト計算 |
| `src/diff/conflict-markers.ts` | merge-file 出力の `<<<<<<<` パーサ |
| `src/diff/range-ops.ts` | `subtractRanges`（強で弱を抑止する純関数） |
| `src/ui/weak-decoration.ts` | 弱装飾コーディネータ（LRU + AbortController + 競合保護） |
| `src/ui/strong-decoration.ts` | 強装飾コーディネータ |
| `src/ui/file-decoration.ts` | Explorer ファイル装飾プロバイダ |

### アーキテクチャ概観

```
                    ┌─────────────┐
                    │ extension.ts│
                    │ (lifecycle) │
                    └──────┬──────┘
            ┌──────────────┼──────────────┬──────────────┐
            ▼              ▼              ▼              ▼
  ┌──────────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────────┐
  │WeakDecoration│ │StrongDecorat.│ │FileDecorat│ │RemoteMonitor │
  │Coordinator   │ │Coordinator   │ │Coordinator│ │(timer)       │
  └──────┬───────┘ └──────┬───────┘ └─────┬─────┘ └──────┬───────┘
         │                │                │              │
         └────compute─────┘                │              │
                ▼                          │              │
         ┌──────────────────┐              │              │
         │computeWeak/Strong│              │              │
         │Highlights        │              │              │
         └──────┬───────────┘              │              │
                ▼                          ▼              ▼
         ┌──────────────────────────────────────────────────────┐
         │ Git layer (runner.ts + cat-file-batch.ts)            │
         │ runBaseDiff / runMergeTree / runMergeFile /          │
         │ resolveMergeBase / listChangedFilesOnBase /          │
         │ checkRemoteForUpdates                                │
         └──────────────────────────────────────────────────────┘
```

### 設計上の決定点

- **`ours = バッファ`**: 強ハイライト計算で `ours` に未保存の編集を含む文字列を渡す。実際のマージ結果（コミット状態 vs base）とは多少ズレるが、UX としては「今このバッファでマージしたらどうなるか」が見える方が有用と判断
- **cat-file --batch**: バッファ追従で頻発する blob 取得を 1 spawn で済ませるため、長命プロセスとして抱え込む
- **`computeRanges` / `applyRanges` の分離**: extension.ts で両 coordinator を並列計算 → `subtractRanges` → 同時適用、というオーケストレーションを可能にするため
- **`protocol.file.allow=user`**: `=never` は正当な local-mirror remote 構成まで殺すので、top-level ユーザコマンドのみ許可しネスト transport は引き続きブロックする `=user` を採用
- **キャッシュキーに `documentVersion`**: バッファが変わったら必ず key が変わる → 古い結果が誤って serve されない保証

---

## ライセンス

MIT

---

## Contributing

Issue / PR 歓迎。提出前に:

```sh
npm test && npm run typecheck && npm run build
```

を通してください。
