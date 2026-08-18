import Stripe from "stripe";
import type { UmecConfig, UmecProduct } from "./config.js";
import { getServerEnv } from "./env.js";

const STRIPE_API_VERSION = "2026-05-27.dahlia";
const MAX_ITEMS = 10;
const MAX_QUANTITY = 20;

type CheckoutItem = {
  sku: string;
  quantity: number;
};

export type CheckoutProductsMap = Record<string, UmecProduct | undefined>;

export type CheckoutCustomField = Stripe.Checkout.SessionCreateParams.CustomField;

export type CheckoutOffer = {
  priceOverrides: Record<string, number>;
  freeShipping: boolean;
  customFields?: CheckoutCustomField[];
  metadata?: Record<string, string>;
  customerEmail?: string;
  unitsRemaining?: Map<string, number>;
};

export type CheckoutOfferUnavailable = {
  error: "Offer not found" | "Offer expired";
  status: 404 | 410;
};

export type CheckStock = (skus: string[]) => Promise<Map<string, number>>;
export type CheckOffer = (offerSlug: string) => Promise<CheckoutOffer | CheckoutOfferUnavailable | null>;

export type CheckoutHandlerOptions = {
  products: CheckoutProductsMap;
  shipping?: UmecConfig["shipping"];
  customFields?: CheckoutCustomField[];
  metadata?: Record<string, string>;
  customerEmail?: string;
  checkStock?: CheckStock;
  checkOffer?: CheckOffer;
};

export type CheckoutHandler = ({ request }: { request: Request }) => Promise<Response>;

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isCheckoutPayload(value: unknown): value is { items?: unknown; offerSlug?: unknown } {
  return typeof value === "object" && value !== null;
}

function isValidQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isOfferUnavailable(value: CheckoutOffer | CheckoutOfferUnavailable): value is CheckoutOfferUnavailable {
  return "error" in value && "status" in value;
}

function omitReservedMetadata(metadata: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== "items" && key !== "offer_slug"),
  );
}

function calcShipping(
  items: CheckoutItem[],
  products: CheckoutProductsMap,
  shipping: NonNullable<UmecConfig["shipping"]>,
) {
  const totalUnits = items.reduce((sum, { sku, quantity }) => {
    return sum + (products[sku]?.shippingUnits ?? 1) * quantity;
  }, 0);

  const tier = shipping.tiers.find((shippingTier) => {
    return shippingTier.maxUnits === undefined || totalUnits <= shippingTier.maxUnits;
  }) ?? shipping.tiers[shipping.tiers.length - 1]!;

  return {
    amount: tier.amount,
    label: tier.label,
  };
}

export function createCheckoutHandler({
  products,
  shipping,
  customFields: staticCustomFields = [],
  metadata: staticMetadata = {},
  customerEmail: staticCustomerEmail,
  checkStock,
  checkOffer,
}: CheckoutHandlerOptions): CheckoutHandler {
  return async ({ request }) => {
    const { STRIPE_SECRET_KEY: stripeKey } = getServerEnv();
    if (!stripeKey) return jsonError("Stripe not configured", 503);

    const stripe = new Stripe(stripeKey, {
      apiVersion: STRIPE_API_VERSION,
    });
    let payload: unknown;

    try {
      payload = await request.json();
    } catch {
      return jsonError("Invalid request body", 400);
    }

    if (!isCheckoutPayload(payload)) return jsonError("Invalid request body", 400);

    const { items } = payload;
    if (!Array.isArray(items) || items.length === 0) return jsonError("Invalid items", 400);
    if (items.length > MAX_ITEMS) return jsonError("Invalid items", 400);

    const rawItems: CheckoutItem[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) return jsonError("Invalid SKU", 400);

      const { sku, quantity } = item as { sku?: unknown; quantity?: unknown };
      if (typeof sku !== "string" || !products[sku]) return jsonError("Invalid SKU", 400);
      if (!isValidQuantity(quantity)) return jsonError("Invalid quantity", 400);

      rawItems.push({ sku, quantity });
    }

    const quantityMap = new Map<string, number>();
    for (const { sku, quantity } of rawItems) {
      quantityMap.set(sku, (quantityMap.get(sku) ?? 0) + quantity);
    }

    for (const [, total] of quantityMap) {
      if (total > MAX_QUANTITY) return jsonError("Invalid quantity", 400);
    }

    const checkoutItems: CheckoutItem[] = Array.from(quantityMap.entries()).map(
      ([sku, quantity]) => ({ sku, quantity }),
    );
    const { offerSlug } = payload as { items?: unknown; offerSlug?: unknown };
    let priceOverrides: Record<string, number> = {};
    let freeShipping = false;
    let offerCustomFields: CheckoutCustomField[] = [];
    let offerMetadata: Record<string, string> = {};
    let customerEmail = staticCustomerEmail;

    if (typeof offerSlug === "string" && offerSlug.trim() !== "") {
      if (!checkOffer) return jsonError("Offer not available", 503);
      const offer = await checkOffer(offerSlug.trim());
      if (!offer) return jsonError("Offer not found", 404);
      if (isOfferUnavailable(offer)) return jsonError(offer.error, offer.status);
      const offerUnits = offer.unitsRemaining;
      if (offerUnits && offerUnits.size > 0) {
        for (const { sku, quantity } of checkoutItems) {
          const remaining = offerUnits.get(sku);
          // TOCTOU race is acceptable for low-frequency sales. Move to Durable Objects if needed.
          if (remaining !== undefined && quantity > remaining) {
            return jsonError(`Offer unit limit reached: ${sku}`, 409);
          }
        }
      }
      priceOverrides = offer.priceOverrides;
      freeShipping = offer.freeShipping;
      offerCustomFields = offer.customFields ?? [];
      offerMetadata = offer.metadata ?? {};
      customerEmail = offer.customerEmail ?? staticCustomerEmail;
    }

    const shippingRate = shipping
      ? freeShipping
        ? { amount: 0, label: shipping.freeLabel }
        : calcShipping(checkoutItems, products, shipping)
      : undefined;
    const stock = checkStock ? await checkStock(checkoutItems.map((item) => item.sku)) : new Map<string, number>();
    for (const { sku, quantity } of checkoutItems) {
      const available = stock.get(sku);
      if (available !== undefined && quantity > available) {
        return jsonError(`Out of stock: ${sku}`, 409);
      }
    }

    const checkoutCustomFields: CheckoutCustomField[] = [
      ...staticCustomFields,
      ...offerCustomFields,
      {
        key: "message",
        label: { type: "custom", custom: "メッセージ・ご要望（任意）" },
        type: "text",
        optional: true,
        text: { maximum_length: 255 },
      },
    ];

    try {
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        ui_mode: "embedded_page",
        mode: "payment",
        line_items: checkoutItems.map(({ sku, quantity }) => ({
          price_data: {
            currency: "jpy",
            product_data: { name: products[sku]!.name },
            unit_amount: priceOverrides[sku] ?? products[sku]!.price,
          },
          quantity,
        })),
        metadata: {
          ...omitReservedMetadata(staticMetadata),
          ...omitReservedMetadata(offerMetadata),
          items: JSON.stringify(checkoutItems),
          ...(typeof offerSlug === "string" && offerSlug.trim() ? { offer_slug: offerSlug.trim() } : {}),
        },
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        phone_number_collection: { enabled: true },
        custom_fields: checkoutCustomFields,
        shipping_address_collection: { allowed_countries: ["JP"] },
        ...(shippingRate
          ? {
              shipping_options: [
                {
                  shipping_rate_data: {
                    type: "fixed_amount",
                    fixed_amount: { amount: shippingRate.amount, currency: "jpy" },
                    display_name: shippingRate.label,
                    delivery_estimate: {
                      minimum: { unit: "business_day", value: 2 },
                      maximum: { unit: "business_day", value: 5 },
                    },
                  },
                },
              ],
            }
          : {}),
        redirect_on_completion: "never",
      };

      const session = await stripe.checkout.sessions.create(sessionParams);

      return new Response(JSON.stringify({ clientSecret: session.client_secret }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      const stripeError = error as {
        type?: string;
        code?: string;
        statusCode?: number;
        requestId?: string;
      };
      console.error("[checkout] stripe session create failed:", {
        type: stripeError.type,
        code: stripeError.code,
        statusCode: stripeError.statusCode,
        requestId: stripeError.requestId,
      });

      if (stripeError.type === "StripePermissionError") {
        return jsonError("Stripe key does not have permission to create Checkout Sessions", 503);
      }

      return jsonError("Checkout session could not be created", 503);
    }
  };
}
