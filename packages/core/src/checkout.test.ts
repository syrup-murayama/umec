import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutCustomField, CheckoutOffer, CheckoutOfferUnavailable } from "./checkout.js";
import type { ServerEnv } from "./env.js";
import type { UmecShipping } from "./config.js";

const { createCheckoutSessionMock, StripeMock } = vi.hoisted(() => {
  const createCheckoutSessionMock = vi.fn();
  const StripeMock = vi.fn(function Stripe() {
    return {
      checkout: {
        sessions: {
          create: createCheckoutSessionMock,
        },
      },
    };
  });

  return { createCheckoutSessionMock, StripeMock };
});

vi.mock("stripe", () => ({
  default: StripeMock,
}));

vi.mock("./env.js", () => ({
  getServerEnv: vi.fn(),
}));

import { createCheckoutHandler } from "./checkout.js";
import { getServerEnv } from "./env.js";

const products = {
  "200ml": {
    name: "うめシロップ 200ml",
    price: 1800,
    active: true,
    shippingUnits: 1,
  },
  "720ml": {
    name: "うめシロップ 720ml",
    price: 4200,
    active: true,
    shippingUnits: 3,
  },
};

const shippingConfig = {
  tiers: [
    { maxUnits: 2, amount: 450, label: "宅急便コンパクト" },
    { amount: 850, label: "宅急便" },
  ],
  freeLabel: "送料無料",
} satisfies UmecShipping;

function expectedShippingOptions(amount: number, displayName: string) {
  return [
    {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount, currency: "jpy" },
        display_name: displayName,
        delivery_estimate: {
          minimum: { unit: "business_day", value: 2 },
          maximum: { unit: "business_day", value: 5 },
        },
      },
    },
  ];
}

function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    RESEND_API_KEY: "re_test_mock",
    RESEND_AUDIENCE_ID: "audience_test_mock",
    ...overrides,
  };
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new Request("http://localhost/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function createPostCheckout(
  options: Partial<Parameters<typeof createCheckoutHandler>[0]> = {},
) {
  const POST = createCheckoutHandler({
    products,
    ...options,
  });

  return {
    postCheckout(body: unknown) {
      return POST({ request: jsonRequest(body) });
    },
    postCheckoutRaw(body: string) {
      return POST({ request: rawRequest(body) });
    },
  };
}

describe("createCheckoutHandler", () => {
  beforeEach(() => {
    vi.mocked(getServerEnv).mockReturnValue(env());
    createCheckoutSessionMock.mockReset();
    createCheckoutSessionMock.mockResolvedValue({
      client_secret: "cs_test_mock_secret",
    });
    StripeMock.mockClear();
  });

  it("creates line items for multiple checkout items", async () => {
    const { postCheckout } = createPostCheckout({ shipping: shippingConfig });
    const items = [
      { sku: "200ml", quantity: 4 },
      { sku: "720ml", quantity: 2 },
    ];

    const response = await postCheckout({ items });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clientSecret: "cs_test_mock_secret",
    });
    expect(StripeMock).toHaveBeenCalledWith("sk_test_mock", {
      apiVersion: "2026-05-27.dahlia",
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        ui_mode: "embedded_page",
        metadata: {
          items: JSON.stringify(items),
        },
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "jpy",
              product_data: { name: products["200ml"].name },
              unit_amount: products["200ml"].price,
            }),
            quantity: 4,
          }),
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "jpy",
              product_data: { name: products["720ml"].name },
              unit_amount: products["720ml"].price,
            }),
            quantity: 2,
          }),
        ],
        shipping_address_collection: { allowed_countries: ["JP"] },
        custom_fields: [
          expect.objectContaining({
            key: "message",
            optional: true,
          }),
        ],
        shipping_options: expectedShippingOptions(850, "宅急便"),
        redirect_on_completion: "never",
      }),
    );
  });

  it("returns a clientSecret for a single checkout item array", async () => {
    const { postCheckout } = createPostCheckout();
    const items = [{ sku: "720ml", quantity: 1 }];

    const response = await postCheckout({ items });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clientSecret: "cs_test_mock_secret",
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          items: JSON.stringify(items),
        },
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              product_data: { name: products["720ml"].name },
              unit_amount: products["720ml"].price,
            }),
            quantity: 1,
          }),
        ],
      }),
    );
  });

  it.each([
    [{ items: [{ sku: "200ml", quantity: 1 }] }, 450, "宅急便コンパクト"],
    [{ items: [{ sku: "200ml", quantity: 2 }] }, 450, "宅急便コンパクト"],
    [{ items: [{ sku: "200ml", quantity: 3 }] }, 850, "宅急便"],
    [{ items: [{ sku: "720ml", quantity: 1 }] }, 850, "宅急便"],
    [{ items: [{ sku: "720ml", quantity: 2 }] }, 850, "宅急便"],
    [{ items: [{ sku: "200ml", quantity: 1 }, { sku: "720ml", quantity: 1 }] }, 850, "宅急便"],
  ])("preserves injected shipping options from shipping config for %o", async (body, expectedAmount, expectedDisplayName) => {
    const { postCheckout } = createPostCheckout({ shipping: shippingConfig });

    const response = await postCheckout(body);

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping_options: expectedShippingOptions(expectedAmount, expectedDisplayName),
      }),
    );
  });

  it("omits shipping_options when shipping config is not provided", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    const params = createCheckoutSessionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("shipping_options" in params).toBe(false);
    expect(params.shipping_address_collection).toEqual({ allowed_countries: ["JP"] });
  });

  it("applies offer price overrides and free shipping for a valid offerSlug", async () => {
    const checkOffer = vi.fn().mockResolvedValue({
      priceOverrides: { "200ml": 1200, "720ml": 2800 },
      freeShipping: true,
    } satisfies CheckoutOffer);
    const { postCheckout } = createPostCheckout({ checkOffer, shipping: shippingConfig });

    const response = await postCheckout({
      offerSlug: "friends-2026",
      items: [
        { sku: "200ml", quantity: 1 },
        { sku: "720ml", quantity: 1 },
      ],
    });

    expect(response.status).toBe(200);
    expect(checkOffer).toHaveBeenCalledWith("friends-2026");
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          offer_slug: "friends-2026",
        }),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 1200 }),
            quantity: 1,
          }),
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 2800 }),
            quantity: 1,
          }),
        ],
        shipping_options: expectedShippingOptions(0, "送料無料"),
      }),
    );
  });

  it("sets only the optional message custom field for regular checkout", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        custom_fields: [
          expect.objectContaining({
            key: "message",
            optional: true,
            type: "text",
            text: { maximum_length: 255 },
          }),
        ],
      }),
    );
  });

  it("prepends injected custom fields to the optional message field", async () => {
    const customFields = [
      {
        key: "class_name",
        label: { type: "custom", custom: "クラス名" },
        type: "text",
        optional: false,
        text: { maximum_length: 50 },
      },
      {
        key: "child_name",
        label: { type: "custom", custom: "お子さんのお名前" },
        type: "text",
        optional: false,
        text: { maximum_length: 50 },
      },
    ] satisfies CheckoutCustomField[];
    const { postCheckout } = createPostCheckout({ customFields });

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        custom_fields: [
          ...customFields,
          expect.objectContaining({
            key: "message",
            optional: true,
            type: "text",
            text: { maximum_length: 255 },
          }),
        ],
      }),
    );
  });

  it("adds custom fields returned by checkOffer before the optional message field", async () => {
    const offerCustomFields = [
      {
        key: "class_name",
        label: { type: "custom", custom: "クラス名" },
        type: "text",
        optional: false,
        text: { maximum_length: 50 },
      },
      {
        key: "child_name",
        label: { type: "custom", custom: "お子さんのお名前" },
        type: "text",
        optional: false,
        text: { maximum_length: 50 },
      },
    ] satisfies CheckoutCustomField[];
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        customFields: offerCustomFields,
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "school-2026",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(200);
    const params = createCheckoutSessionMock.mock.calls[0]?.[0] as {
      custom_fields?: CheckoutCustomField[];
    };
    expect(params.custom_fields).toEqual([
      ...offerCustomFields,
      expect.objectContaining({
        key: "message",
        optional: true,
        type: "text",
        text: { maximum_length: 255 },
      }),
    ]);
  });

  it("combines static and offer-specific custom fields in that order", async () => {
    const staticCustomFields = [
      {
        key: "company_name",
        label: { type: "custom", custom: "会社名" },
        type: "text",
        optional: true,
        text: { maximum_length: 100 },
      },
    ] satisfies CheckoutCustomField[];
    const offerCustomFields = [
      {
        key: "class_name",
        label: { type: "custom", custom: "クラス名" },
        type: "text",
        optional: false,
        text: { maximum_length: 50 },
      },
    ] satisfies CheckoutCustomField[];
    const { postCheckout } = createPostCheckout({
      customFields: staticCustomFields,
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        customFields: offerCustomFields,
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "school-2026",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(200);
    const params = createCheckoutSessionMock.mock.calls[0]?.[0] as {
      custom_fields?: CheckoutCustomField[];
    };
    expect(params.custom_fields).toEqual([
      ...staticCustomFields,
      ...offerCustomFields,
      expect.objectContaining({ key: "message" }),
    ]);
  });

  it("combines static and offer metadata while protecting reserved keys", async () => {
    const items = [{ sku: "200ml", quantity: 1 }];
    const { postCheckout } = createPostCheckout({
      metadata: {
        run_id: "static-run",
        source: "smoke-test",
        items: "static-items",
        offer_slug: "static-offer",
      },
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        metadata: {
          run_id: "offer-run",
          cohort: "fleet",
          items: "offer-items",
          offer_slug: "offer-override",
        },
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({ offerSlug: "school-2026", items });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          run_id: "offer-run",
          source: "smoke-test",
          cohort: "fleet",
          items: JSON.stringify(items),
          offer_slug: "school-2026",
        },
      }),
    );
  });

  it("omits an injected reserved offer_slug from regular checkout metadata", async () => {
    const items = [{ sku: "200ml", quantity: 1 }];
    const { postCheckout } = createPostCheckout({
      metadata: {
        run_id: "run-123",
        offer_slug: "injected-offer",
      },
    });

    const response = await postCheckout({ items });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          run_id: "run-123",
          items: JSON.stringify(items),
        },
      }),
    );
  });

  it("sets an injected customer email", async () => {
    const { postCheckout } = createPostCheckout({
      customerEmail: "customer@example.com",
    });

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_email: "customer@example.com",
      }),
    );
  });

  it("uses the offer customer email after the static customer email", async () => {
    const { postCheckout } = createPostCheckout({
      customerEmail: "static@example.com",
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        customerEmail: "offer@example.com",
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "school-2026",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_email: "offer@example.com",
      }),
    );
  });

  it.each([undefined, ""])("omits customer_email when the injected value is %s", async (customerEmail) => {
    const { postCheckout } = createPostCheckout({ customerEmail });

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    const params = createCheckoutSessionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("customer_email" in params).toBe(false);
  });

  it("returns 410 for an expired offerSlug", async () => {
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue({
        error: "Offer expired",
        status: 410,
      } satisfies CheckoutOfferUnavailable),
    });

    const response = await postCheckout({
      offerSlug: "expired-offer",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "Offer expired" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 409 when a per-SKU offer unit limit is exceeded", async () => {
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        unitsRemaining: new Map([["200ml", 1]]),
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "friends-2026",
      items: [{ sku: "200ml", quantity: 2 }],
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Offer unit limit reached: 200ml" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("allows checkout when a per-SKU offer unit limit has enough remaining units", async () => {
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        unitsRemaining: new Map([["200ml", 2]]),
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "friends-2026",
      items: [{ sku: "200ml", quantity: 2 }],
    });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalled();
  });

  it("skips per-SKU offer unit checks when the offer has no capped SKUs", async () => {
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue({
        priceOverrides: {},
        freeShipping: false,
        unitsRemaining: new Map(),
      } satisfies CheckoutOffer),
    });

    const response = await postCheckout({
      offerSlug: "friends-2026",
      items: [{ sku: "200ml", quantity: 2 }],
    });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalled();
  });

  it("returns 404 for an inactive offerSlug", async () => {
    const { postCheckout } = createPostCheckout({
      checkOffer: vi.fn().mockResolvedValue(null),
    });

    const response = await postCheckout({
      offerSlug: "inactive-offer",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Offer not found" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 503 for an offerSlug when checkOffer is not configured", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({
      offerSlug: "friends-2026",
      items: [{ sku: "200ml", quantity: 1 }],
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Offer not available" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid SKU in the items array", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({
      items: [
        { sku: "200ml", quantity: 1 },
        { sku: "999ml", quantity: 1 },
      ],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid SKU" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 409 when requested quantity exceeds stock", async () => {
    const { postCheckout } = createPostCheckout({
      checkStock: vi.fn().mockResolvedValue(new Map([["200ml", 0]])),
    });

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Out of stock: 200ml" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("skips stock checks when checkStock is not configured", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalled();
  });

  it("returns 400 for a zero quantity", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 0 }] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid quantity" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a quantity over MAX_QUANTITY", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 21 }] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid quantity" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty items array", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid items" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it.each([{}, { items: undefined }, { items: "200ml" }, { items: null }])(
    "returns 400 for missing or non-array items: %o",
    async (body) => {
      const { postCheckout } = createPostCheckout();

      const response = await postCheckout(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid items" });
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    },
  );

  it("returns 400 for invalid JSON", async () => {
    const { postCheckoutRaw } = createPostCheckout();

    const response = await postCheckoutRaw("{");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env({ STRIPE_SECRET_KEY: "" }));
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Stripe not configured" });
    expect(StripeMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the Stripe key cannot create Checkout Sessions", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createCheckoutSessionMock.mockRejectedValue({
      type: "StripePermissionError",
      code: "permission_error",
      statusCode: 403,
      requestId: "req_mock",
    });
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe key does not have permission to create Checkout Sessions",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[checkout] stripe session create failed:",
      expect.objectContaining({
        type: "StripePermissionError",
        statusCode: 403,
        requestId: "req_mock",
      }),
    );

    consoleErrorSpy.mockRestore();
  });

  it("returns 503 when Stripe session creation fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createCheckoutSessionMock.mockRejectedValue({
      type: "StripeAPIError",
      code: "api_error",
      statusCode: 500,
      requestId: "req_mock",
    });
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({ items: [{ sku: "200ml", quantity: 1 }] });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Checkout session could not be created",
    });

    consoleErrorSpy.mockRestore();
  });

  it("returns 400 when items array exceeds MAX_ITEMS", async () => {
    const { postCheckout } = createPostCheckout();
    const items = Array.from({ length: 11 }, () => ({ sku: "200ml", quantity: 1 }));

    const response = await postCheckout({ items });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid items" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("returns 400 when duplicate SKUs exceed MAX_QUANTITY after merging", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({
      items: [
        { sku: "200ml", quantity: 11 },
        { sku: "200ml", quantity: 11 },
      ],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid quantity" });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("merges duplicate SKUs into a single line item within MAX_QUANTITY", async () => {
    const { postCheckout } = createPostCheckout();

    const response = await postCheckout({
      items: [
        { sku: "200ml", quantity: 5 },
        { sku: "200ml", quantity: 5 },
      ],
    });

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              product_data: { name: products["200ml"].name },
              unit_amount: products["200ml"].price,
            }),
            quantity: 10,
          }),
        ],
      }),
    );
  });
});
