import { Resend } from "resend";
import type { UnshippedOrder as SnapshotUnshippedOrder } from "./db/orders.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UnshippedOrder = SnapshotUnshippedOrder;

export type NotifyEnv = {
  DISCORD_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
};

type CheckoutItem = {
  sku?: unknown;
  quantity?: unknown;
};

export type NotifyProduct = {
  name: string;
};

export type NotifyProductsMap = Record<string, NotifyProduct | undefined>;

export type NotifyUnshippedOptions = {
  alertFrom: string;
  alertTo: string;
  alertSubject: string;
  products?: NotifyProductsMap;
};

function formatYen(value: number | null) {
  if (value == null) return "-";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

function parseTimestamp(value: number | string | null) {
  if (value == null || value === "") return null;
  const timestamp = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseItems(itemsJson: string | null, products: NotifyProductsMap) {
  if (!itemsJson) return "-";

  try {
    const parsed: unknown = JSON.parse(itemsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return "-";

    return parsed
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const { sku, quantity } = item as CheckoutItem;
        const productSku = typeof sku === "string" ? sku : "";
        const productName = productSku && products[productSku] ? products[productSku].name : productSku || "商品";
        const itemQuantity = typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 0;
        return `${productName} x ${itemQuantity}`;
      })
      .filter((item): item is string => Boolean(item))
      .join(", ");
  } catch {
    return "-";
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function notificationErrorSuffix(error: unknown) {
  if (typeof error !== "object" || error === null) return "";
  const value = error as { name?: unknown; statusCode?: unknown };
  const details = [
    typeof value.name === "string" ? `name=${value.name}` : null,
    typeof value.statusCode === "number" ? `statusCode=${value.statusCode}` : null,
  ].filter((detail): detail is string => detail !== null);

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatOrderLine(order: UnshippedOrder, products: NotifyProductsMap, now = Date.now()) {
  const createdAt = parseTimestamp(order.created_at);
  const elapsedDays = createdAt == null ? "-" : String(Math.floor((now - createdAt) / DAY_MS));
  const name = order.name?.trim() || "お客様";
  return `${name} | ${parseItems(order.items_json, products)} | ${formatYen(order.amount)} | ${elapsedDays}日`;
}

export async function notifyUnshipped(
  orders: UnshippedOrder[],
  env: NotifyEnv,
  { alertFrom, alertTo, alertSubject, products = {} }: NotifyUnshippedOptions,
) {
  if (orders.length === 0) return;
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");

  const lines = orders.map((order) => formatOrderLine(order, products));
  const content = ["未発送アラート: pending の注文があります。", "", ...lines].join("\n");

  if (env.DISCORD_WEBHOOK_URL) {
    const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!discordResponse.ok) {
      throw new Error(`Discord notification failed: ${discordResponse.status}`);
    }
  }

  const rows = lines
    .map((line) => {
      const [name, items, amount, elapsedDays] = line.split(" | ");
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(name ?? "")}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(items ?? "")}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(amount ?? "")}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(elapsedDays ?? "")}</td>
      </tr>`;
    })
    .join("");

  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: alertFrom,
    to: alertTo,
    subject: alertSubject,
    html: `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;color:#222;max-width:720px;margin:0 auto;padding:32px 16px;">
  <h1 style="font-size:20px;margin:0 0 16px;">未発送アラート</h1>
  <p style="font-size:14px;line-height:1.7;color:#555;">pending のまま threshold を超えた注文があります。</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead>
      <tr>
        <th style="padding:8px;border-bottom:2px solid #222;text-align:left;">名前</th>
        <th style="padding:8px;border-bottom:2px solid #222;text-align:left;">商品</th>
        <th style="padding:8px;border-bottom:2px solid #222;text-align:right;">金額</th>
        <th style="padding:8px;border-bottom:2px solid #222;text-align:right;">経過日数</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`,
    text: content,
  });
  if (error) {
    throw new Error(`Resend notification failed${notificationErrorSuffix(error)}`);
  }
}
