# .doc/AGENTS.md — emu umesyrup AI サポートガイド

> このファイルを Claude Code / Cursor / Windsurf に `@.doc/AGENTS.md` で参照させると、
> このリポジトリのアーキテクチャを前提にした正確なサポートが受けられる。

## プロジェクト概要

**サイト**: emu.muraya.ma  
**内容**: 梅シロップブランド「emu」のブランドサイト + EC（本番稼働中）  
**スタック**: Astro 6（SSR）/ Tailwind CSS 4 / TypeScript / Cloudflare Workers / Stripe / Resend

---

## アーキテクチャ図

```
ブラウザ
  │
  ├─ GET /            → Astro SSR（ブランドページ）
  ├─ GET /item        → Astro SSR（商品詳細）
  │    └─ Checkout ボタン → CheckoutModal.astro
  │         └─ POST /api/checkout  ──→ Stripe Checkout Session 作成
  │              └─ stripe.checkout.sessions.create (embedded_page)
  │                   └─ clientSecret をブラウザに返す
  │                        └─ Stripe.js で embedded checkout 表示
  │
  ├─ POST /api/webhook ──→ Stripe Webhook 受信
  │    └─ event.type === 'checkout.session.completed'
  │         └─ Resend でオーナー（studio@muraya.ma）に注文メール
  │              ※ 購入者向けメールは現状未実装（Stripe の receipt が代替）
  │
  └─ POST /api/subscribe ──→ Resend Audience に連絡先登録（ニュースレター）
```

## ディレクトリ構成

```
src/
  components/
    CheckoutModal.astro   # Stripe embedded checkout のモーダル UI
    Footer.astro
    sections/             # Hero, StoryScroll, Product, Subscribe 等のセクション
  config/
    links.ts              # SITE.url / SNS / STUDIO 定数
    email.ts              # ORDER_EMAIL（送信元・BCC）定数
  layouts/
    Layout.astro          # HTML shell（メタタグ・スタイル・共通 script）
  pages/
    index.astro           # トップページ
    item.astro            # 商品詳細ページ
    story.astro           # ブランドストーリー
    api/
      checkout.ts         # POST: Stripe Checkout Session 作成
      webhook.ts          # POST: Stripe Webhook 受信・注文メール送信
      subscribe.ts        # POST: Resend Audience 登録
  styles/
    global.css            # @theme でデザイントークン管理（Tailwind CSS 4）
public/
  images/                 # 商品・ブランド画像
wrangler.jsonc            # CF Workers 設定（デプロイの正）
astro.config.mjs          # output: server, adapter: cloudflare()
```

## 環境変数

### CF Workers Secret（`wrangler secret put` またはダッシュボードで設定）
| 変数名 | 用途 |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe API 呼び出し（`sk_live_...`） |
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名検証（`whsec_...`） |
| `RESEND_API_KEY` | メール送信（Full Access キー必須） |
| `RESEND_AUDIENCE_ID` | ニュースレター登録先の Audience ID |

**重要**: `wrangler deploy` は CF Workers ダッシュボードの設定を上書きする。Secret は `wrangler secret put` で管理し、`wrangler.jsonc` の `vars` には Secret 以外のビルド変数のみ記述する。

### ビルド変数（`.env` + `wrangler.jsonc` vars 両方に定義）
| 変数名 | 用途 |
|---|---|
| `PUBLIC_STRIPE_PUBLISHABLE_KEY` | フロントエンドの Stripe.js 初期化 |
| `PUBLIC_NOINDEX` | `true` のとき `<meta name="robots" content="noindex">` |
| `PUBLIC_MAINTENANCE_MODE` | `true` のとき全ページをメンテナンス画面に切替 |

`PUBLIC_` 変数はビルド時にインライン化される。サーバー Secret は `src/lib/env.ts` の `getServerEnv()` 経由でのみアクセスする。

---

## 商品マスタ

`src/pages/api/checkout.ts` の `PRODUCTS` 定数で管理。

```ts
const PRODUCTS = {
  '200ml': { name: 'emu クラフト梅シロップ 200ml', price: 1500 },  // 税込・送料別
  '720ml': { name: 'emu クラフト梅シロップ 720ml', price: 3500 },
};
```

**商品価格・名称を変更するときはここだけ編集する。**  
Stripe ダッシュボードの Price ID は使わず `price_data` でセッション内に直接定義しているため、Stripe 側の変更は不要。

---

## troubleshooting/

### Stripe Checkout が開かない / clientSecret が返らない

**確認手順:**
1. ブラウザの Network タブで `POST /api/checkout` のレスポンスを確認
2. レスポンスに `{ "error": "Stripe not configured" }` → `STRIPE_SECRET_KEY` が未設定
3. レスポンスに `{ "error": "Stripe key does not have permission..." }` → シークレットキーが Checkout 権限を持っていない（Restricted Key の場合は Checkout セッション作成権限を追加）
4. Stripe ダッシュボードで該当セッションを確認: Payments → Checkout Sessions

**ログ確認:**
```bash
wrangler tail  # リアルタイムログ
```
または CF Workers ダッシュボード → Workers & Pages → emu-umesyrup → Logs

---

### Webhook が届かない / 注文メールが来ない

**確認手順:**
1. Stripe ダッシュボード → Developers → Webhooks → イベントログを確認
2. `[webhook] Invalid signature` のログ → `STRIPE_WEBHOOK_SECRET` が間違っている（`whsec_...` のシークレット）
3. Vercel Functions ログで `[webhook] POST received` を確認
4. `checkout.session.completed` が届いているか確認
5. Resend ダッシュボードでメール送信ログを確認

**ローカルでの Webhook テスト:**
```bash
stripe listen --forward-to localhost:4321/api/webhook
# 別ターミナルで
stripe trigger checkout.session.completed
```

---

### ニュースレター登録が失敗する

1. Vercel Functions ログで `[subscribe]` のエントリを確認
2. `RESEND_API_KEY` が Full Access キーであることを確認（Sending Access のみでは Audience 操作不可）
3. `RESEND_AUDIENCE_ID` が正しい Audience の ID か Resend ダッシュボードで確認

---

### ビルドエラー

```bash
# ローカルでビルド確認
pnpm run build

# 型チェック
pnpm exec astro check
```

よくある原因:
- `.env` ファイルがない（`.env.example` をコピーして `.env` に）
- `astro.config.mjs` の `adapter` が `cloudflare()` になっているか確認
- `wrangler.jsonc` の `vars` に `PUBLIC_STRIPE_PUBLISHABLE_KEY` が定義されているか確認（未定義だとビルド変数が空になる）

---

## runbooks/

### 商品を追加・変更する

1. `src/pages/api/checkout.ts` の `PRODUCTS` 定数を編集
2. 対応する UI（`src/components/sections/Product.astro` または `ItemDetail.astro`）を更新
3. `pnpm run build` でビルド確認
4. git push → Vercel が自動デプロイ

**注意**: Stripe ダッシュボードの設定は変更不要（price_data で直接定義しているため）

---

### 送料を変更する

`src/pages/api/checkout.ts` 内の `shipping_options` の `amount` を変更する（単位: 円）。

```ts
fixed_amount: { amount: 850, currency: 'jpy' },  // ← ここを変更
```

---

### メンテナンスモードにする

```bash
PUBLIC_MAINTENANCE_MODE=true pnpm run build
# ビルド後に Vercel へデプロイ
```

または Vercel ダッシュボードの Environment Variables で `PUBLIC_MAINTENANCE_MODE=true` に設定して再デプロイ。

---

### Cloudflare Workers へのデプロイ

```bash
pnpm run build && wrangler deploy
```

**メンテナンスモード ON でデプロイ:**
```bash
PUBLIC_MAINTENANCE_MODE=true pnpm run build && wrangler deploy
```

---

## AI に任せてよい範囲 / 要確認の範囲

| AI が対応可能 | Daisuke の確認が必要 |
|---|---|
| UI の修正・デザイン変更 | 本番決済フロー・価格の変更 |
| ビルドエラーの修正 | Stripe Webhook Secret の変更 |
| ローカルでのテスト実行 | 顧客データへのアクセス |
| 文書・コメントの更新 | CF Workers 環境変数・Secret の変更 |
| Preview デプロイの確認 | 送料・税設定の変更 |

**絶対にやらない（AI・人間とも）:**
- `.env` ファイルをコミット
- `STRIPE_SECRET_KEY` をコード内に直接書く
- 本番の Stripe Webhook Secret を変更せずに endpoint URL を変える
