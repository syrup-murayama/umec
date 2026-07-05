# umec

**ume + ec** - 梅シロップを販売するために作った最小の EC から生まれたツールキット。

個人のメーカーが、固定費ゼロで、自分のブランドのオンライン販売を持続可能に運営するための
モダンな解決策を提供する。巨大な EC カートシステムではなく、小さく始めて自分で育てる。

## パッケージ

| パッケージ | 概要 |
|---|---|
| [`@umec/core`](./packages/core) | EC のビジネスロジック（checkout / webhook / subscribe / middleware / notify / config スキーマ）。実際に稼働中の梅シロップ EC から抽出し、同じ EC が最初の利用者として dogfood 運用中 |
| [`@umec/create`](./packages/create) | EC スターターキットのセットアップ CLI |

## 設計の考え方

- **thin adapter**: ビジネスロジックは `@umec/core` が持ち、あなたのサイト側は数行のアダプタで呼び出すだけ。コアの更新があなたのデザインやカスタマイズを壊さない
- **`umec.config.ts` が唯一の契約**: 商品・ブランド・送料・メールの設定は zod スキーマで検証される 1 ファイルに集約。壊れた設定は起動時に人間にも AI にも読めるエラーで止まる
- **送料込み価格**: 送料計算で購入者を迷わせない。送料を分けたいショップには段階制（tiers）も用意
- **ライセンス**: MIT。コアと CLI はオープンソース

## クイックスタート

```bash
npm create @umec
```

## ミッション

> 組織化された大量の製品販売のための巨大な EC カートシステムではなく、
> 個人のメーカーが持続可能に D2C を実現するためのモダンな解決策。

Cloudflare Workers x Stripe x Resend で構成。月額固定費ゼロから始められる。

---

Built by [@syrup-murayama](https://github.com/syrup-murayama)
