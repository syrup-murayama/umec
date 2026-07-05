import { Resend } from "resend";
import Stripe from "stripe";
import { getServerEnv } from "./env.js";

const STRIPE_API_VERSION = "2026-05-27.dahlia";

type ShippingDetails = NonNullable<
  NonNullable<Stripe.Checkout.Session["collected_information"]>["shipping_details"]
>;
type SessionWithLegacyShipping = Stripe.Checkout.Session & {
  shipping_details?: ShippingDetails | null;
};
export type WebhookItem = {
  sku: string;
  quantity: number;
};
export type SupportedWebhookEvent =
  | "checkout.session.completed"
  | "checkout.session.expired"
  | "charge.refunded";

export type OrderEmailLineItem = {
  description: string | null;
  quantity: number | null;
  amount: number | null;
};

export type OrderEmailData = {
  name: string;
  email: string;
  phone: string | null;
  items: OrderEmailLineItem[];
  totalAmount: number;
  shippingCostAmount: number | null;
  shipping: ShippingDetails | null | undefined;
  customFields: Record<string, string>;
};

export type RenderOrderEmail = (order: OrderEmailData) => { subject: string; html: string };

export type WebhookOrder = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  items: WebhookItem[];
  amount: number;
  shippingCost: number | null;
  shippingAddress: ShippingDetails | null | undefined;
  paymentIntent: string | null;
  offerSlug: string | null;
  customFields: Record<string, string> | null;
  createdAt: number;
};

export type WebhookRecordedOrder = {
  items: WebhookItem[];
  offerSlug: string | null;
};

export type WebhookHandlerOptions = {
  claimEvent?: (eventId: string) => Promise<boolean>;
  recordRefund?: (paymentIntentId: string) => Promise<WebhookRecordedOrder | null>;
  recordExpiry?: (sessionId: string) => Promise<WebhookRecordedOrder | null>;
  recordOrder?: (order: WebhookOrder) => Promise<void>;
  restoreStock?: (items: WebhookItem[]) => Promise<void>;
  decrementStock?: (items: WebhookItem[]) => Promise<void>;
  incrementOfferSold?: (offerSlug: string, items: WebhookItem[]) => Promise<void>;
  decrementOfferSold?: (offerSlug: string, items: WebhookItem[]) => Promise<void>;
  renderOrderEmail?: RenderOrderEmail;
  orderEmailFrom?: string;
  orderEmailBcc?: string | string[];
};

export type WebhookHandler = ({ request }: { request: Request }) => Promise<Response>;

function parseCheckoutItems(items: string | null | undefined): WebhookItem[] {
  if (!items) return [];

  try {
    const parsed: unknown = JSON.parse(items);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is WebhookItem => {
      if (typeof item !== "object" || item === null) return false;
      const { sku, quantity } = item as { sku?: unknown; quantity?: unknown };
      return typeof sku === "string" && typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0;
    });
  } catch {
    return [];
  }
}

function isSupportedWebhookEvent(type: string): type is SupportedWebhookEvent {
  return (
    type === "checkout.session.completed" ||
    type === "checkout.session.expired" ||
    type === "charge.refunded"
  );
}

function getPaymentIntentId(paymentIntent: string | Stripe.PaymentIntent | null) {
  if (typeof paymentIntent === "string") return paymentIntent;
  return paymentIntent?.id ?? null;
}

function providerErrorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const value = error as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    message?: unknown;
  };

  return {
    name: typeof value.name === "string" ? value.name : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    statusCode: typeof value.statusCode === "number" ? value.statusCode : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

async function restoreRecordedOrder(
  order: WebhookRecordedOrder | null,
  restoreStock?: (items: WebhookItem[]) => Promise<void>,
  decrementOfferSold?: (offerSlug: string, items: WebhookItem[]) => Promise<void>,
) {
  const items = order?.items ?? [];
  if (items.length > 0 && restoreStock) await restoreStock(items);
  if (order?.offerSlug && decrementOfferSold) {
    await decrementOfferSold(order.offerSlug, items);
  }
}

export const GET: WebhookHandler = async () => new Response("OK", { status: 200 });

export function createWebhookHandler({
  claimEvent,
  recordRefund,
  recordExpiry,
  recordOrder,
  restoreStock,
  decrementStock,
  incrementOfferSold,
  decrementOfferSold,
  renderOrderEmail,
  orderEmailFrom,
  orderEmailBcc,
}: WebhookHandlerOptions = {}): WebhookHandler {
  return async ({ request }) => {
    console.log("[webhook] POST received, method:", request.method);

    const {
      STRIPE_SECRET_KEY: stripeKey,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      RESEND_API_KEY: resendKey,
    } = getServerEnv();

    if (!stripeKey || !webhookSecret) {
      console.error("[webhook] Stripe env not configured");
      return new Response("Server error", { status: 500 });
    }

    const sig = request.headers.get("stripe-signature");
    if (!sig) return new Response("Bad request", { status: 400 });

    const payload = await request.text();

    const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION });

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(payload, sig, webhookSecret);
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }

    if (!isSupportedWebhookEvent(event.type)) {
      return new Response("OK", { status: 200 });
    }

    if (claimEvent) {
      const claim = await claimEvent(event.id);
      if (!claim) {
        console.log("[webhook] duplicate event skipped:", event.id);
        return new Response("OK", { status: 200 });
      }
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntent = getPaymentIntentId(charge.payment_intent);

      if (paymentIntent && recordRefund) {
        const order = await recordRefund(paymentIntent);
        await restoreRecordedOrder(order, restoreStock, decrementOfferSold);
      }

      return new Response("OK", { status: 200 });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    if (event.type === "checkout.session.expired") {
      if (recordExpiry) {
        const order = await recordExpiry(session.id);
        await restoreRecordedOrder(order, restoreStock, decrementOfferSold);
      }

      return new Response("OK", { status: 200 });
    }

    const email = session.customer_details?.email;
    const customerName = session.customer_details?.name ?? null;
    const name = customerName ?? "お客様";
    const phone = session.customer_details?.phone ?? null;
    const totalAmount = session.amount_total ?? 0;
    const shippingCostAmount = session.shipping_cost?.amount_total ?? null;
    const paymentIntent = getPaymentIntentId(session.payment_intent);
    const checkoutItems = parseCheckoutItems(session.metadata?.items);
    const cf: Record<string, string> = {};
    for (const f of (session.custom_fields ?? []) as Array<{
      key: string;
      type: string;
      text?: { value?: string | null };
      dropdown?: { value?: string | null };
    }>) {
      const v = f.type === "dropdown" ? f.dropdown?.value : f.text?.value;
      if (typeof v === "string" && v.trim() !== "") cf[f.key] = v.trim();
    }
    const customFields = Object.keys(cf).length > 0 ? cf : null;

    const shipping =
      session.collected_information?.shipping_details ??
      (session as SessionWithLegacyShipping).shipping_details;

    const offerSlugFromMeta = session.metadata?.offer_slug ?? null;

    if (recordOrder) {
      await recordOrder({
        id: session.id,
        email: email ?? "",
        name: customerName,
        phone,
        items: checkoutItems,
        amount: totalAmount,
        shippingCost: shippingCostAmount,
        shippingAddress: shipping,
        paymentIntent,
        offerSlug: offerSlugFromMeta,
        customFields,
        createdAt: Date.now(),
      });
      if (checkoutItems.length > 0 && decrementStock) await decrementStock(checkoutItems);
      if (offerSlugFromMeta && checkoutItems.length > 0 && incrementOfferSold) {
        await incrementOfferSold(offerSlugFromMeta, checkoutItems);
      }
    }

    let lineItems: Stripe.LineItem[] = [];
    try {
      const result = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      lineItems = result.data;
    } catch (e) {
      console.error("[webhook] listLineItems failed:", providerErrorDetails(e));
    }

    if (!email) {
      console.error("[webhook] no customer email in session:", session.id);
      return new Response("OK", { status: 200 });
    }

    if (!resendKey || !renderOrderEmail || !orderEmailFrom) {
      if (!resendKey) console.error("[webhook] RESEND_API_KEY not set");
      return new Response("OK", { status: 200 });
    }

    const { subject, html } = renderOrderEmail({
      name,
      email,
      phone,
      items: lineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        amount: item.amount_total,
      })),
      totalAmount,
      shippingCostAmount,
      shipping,
      customFields: cf,
    });

    try {
      const resend = new Resend(resendKey);
      const { error } = await resend.emails.send({
        from: orderEmailFrom,
        to: email,
        ...(orderEmailBcc ? { bcc: orderEmailBcc } : {}),
        subject,
        html,
      });
      if (error) {
        console.error("[webhook] Resend error:", providerErrorDetails(error));
      }
    } catch (e) {
      console.error("[webhook] Resend exception:", providerErrorDetails(e));
    }

    return new Response("OK", { status: 200 });
  };
}
