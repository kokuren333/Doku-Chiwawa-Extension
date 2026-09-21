# 毒エロチワワ Chrome Extension

日本語テキストを **チワワ / 毒チワワ / エロチワワ / 毒エロチワワ** の4状態で表示する、シンプルなChrome拡張です。

推論はブラウザ内で行い、モデルは Hugging Face の [`kokuren/doku-ero-chiwawa-japanese`](https://huggingface.co/kokuren/doku-ero-chiwawa-japanese) から初回のみ取得します。

## 表示

ホバー判定・選択テキスト判定では raw score を出さず、判定だけ表示します。

- `チワワ` — 白
- `毒チワワ` — **毒**が紫、チワワが白
- `エロチワワ` — **エロ**がピンク、チワワが白
- `毒エロチワワ` — **毒**が紫、**エロ**がピンク、チワワが白

投稿前チェックだけは、判定に加えて **毒 raw / エロ raw** を表示します。

## 判定モデル

1つの DeBERTa-v2 small から2つの独立logitを出す dual-binary モデルです。

```text
output 0 = doku
output 1 = ero
```

FP32 ONNXを使用します。dynamic INT8は検証時の性能低下が大きかったため使用しません。

現在のdecision threshold:

```text
Doku = 0.560
Ero  = 0.599
```

拡張機能はモデルrepoの `metadata.json` に閾値があればそれを優先し、取得できない場合だけ上記値へフォールバックします。

## 機能

- X / Twitter のポストへマウスを置くと自動判定
  - 判定チップはマウスポインタの近くに追従表示
- Xの表示モード
  - チワワだけ表示
  - 毒チワワ表示（毒エロチワワを含む）
  - エロチワワ表示（毒エロチワワを含む）
  - 毒エロチワワだけ表示
  - ポストの上端がブラウザ表示の上3/5付近まで来てから約0.7秒待って判定
  - 残すポストにも分類スタンプを表示し、判定後にアバター左上へ縮小固定
  - 対象外ポストは判定後、分類ごとの画像スタンプ、ヒビ割れ、霧散の順で非表示
  - 判定は最大2件ずつ行い、放置中は約6.5秒で一時停止。スクロール・キー操作で再開
- 任意Webページで選択したテキストを判定
- 投稿前チェックウィンドウ
  - 入力中に自動判定
  - 毒/エロ raw score を表示
  - コピー機能
- モデルの事前準備
- モデルキャッシュ削除

## インストール（開発者モード）

1. このリポジトリを clone またはZIP展開
2. Chromeで `chrome://extensions` を開く
3. 「デベロッパー モード」をON
4. 「パッケージ化されていない拡張機能を読み込む」
5. このリポジトリのルートフォルダを選択

初回判定時に Hugging Face からFP32 ONNXモデル（約72MB）とtokenizerを取得します。

## GitHubへpush

このZIPの中身をそのままリポジトリルートに置けます。

```powershell
git init
git add .
git commit -m "Initial Doku Ero Chiwawa extension"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## プライバシー

判定対象テキストそのものを外部APIへ送る設計ではありません。モデル/tokenizerの取得後、ONNX Runtime Web (WASM) でブラウザ内推論します。

## ディレクトリ

```text
manifest.json
background.js
offscreen.html
offscreen.js
content.js
content.css
popup.html
popup.js
popup.css
icons/
assets/
vendor/
```

`vendor/` にはONNX Runtime WebのWASMランタイムを同梱しています。

## モデル

- Hugging Face: https://huggingface.co/kokuren/doku-ero-chiwawa-japanese
- Base: `izumi-lab/deberta-v2-small-japanese`
- Max length: 192 tokens
- Runtime: FP32 ONNX / ONNX Runtime Web WASM

長文は192 token以内のチャンクへ分割し、複数チャンクの場合は各headの最大スコアで判定します。

## 注意

このモデルの出力は教師ラベルを学習した推定値であり、普遍的な「有害性」や「性的内容」の真値ではありません。モデレーション、処罰、医療・法的判断などの唯一の根拠として使用しないでください。
