import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "./env.js";
import type { WebhookHandlerOptions } from "./webhook.js";

const {
  constructEventAsyncMock,
  listLineItemsMock,
  sendEmailMock,
  StripeMock,
  ResendMock,
} = vi.hoisted(() => {
  const constructEventAsyncMock = vi.fn();
  const listLineItemsMock = vi.fn();
  const sendEmailMock = vi.fn();
  const StripeMock = vi.fn(function Stripe() {
    return {
      webhooks: {
        constructEventAsync: constructEventAsyncMock,
      },
      checkout: {
        sessions: {
          listLineItems: listLineItemsMock,
        },
      },
    };
  });
  const ResendMock = vi.fn(function Resend() {
    return {
      emails: {
        send: sendEmailMock,
      },
    };
  });

  return {
    constructEventAsyncMock,
    listLineItemsMock,
    sendEmailMock,
    StripeMock,
    ResendMock,
  };
});

vi.mock("stripe", () => ({
  default: StripeMock,
}));

vi.mock("resend", () => ({
  Resend: ResendMock,
}));

vi.mock("./env.js", () => ({
  getServerEnv: vi.fn(),
}));

import { getServerEnv } from "./env.js";
import { createWebhookHandler, GET } from "./webhook.js";

function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    RESEND_API_KEY: "re_test_mock",
    RESEND_AUDIENCE_ID: "audience_test_mock",
    ...overrides,
  };
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_mock",
    object: "checkout.session",
    payment_intent: "pi_test_mock",
    metadata: {
      items: JSON.stringify([{ sku: "200ml", quantity: 2 }]),
    },
    customer_details: {
      email: "test@example.com",
      name: "テスト 太郎",
      phone: "0312345678",
    },
    amount_total: 4700,
    shipping_cost: {
      amount_total: 450,
    },
    collected_information: {
      shipping_details: {
        name: "テスト 太郎",
        address: {
          country: "JP",
          postal_code: "1500001",
          state: "東京都",
          city: "渋谷区",
          line1: "神宮前1-1-1",
          line2: "101",
        },
      },
    },
    ...overrides,
  };
}

function stripeEvent(type = "checkout.session.completed", session = checkoutSession()) {
  return {
    id: "evt_test_mock",
    object: "event",
    type,
    data: {
      object: session,
    },
  };
}

function chargeRefundedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_refunded_mock",
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_test_mock",
        object: "charge",
        payment_intent: "pi_test_mock",
        ...overrides,
      },
    },
  };
}

function webhookRequest(headers: Record<string, string> = { "stripe-signature": "sig_test" }) {
  return new Request("http://localhost/api/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "evt_test_mock" }),
  });
}

function createPostWebhook(options: WebhookHandlerOptions = {}) {
  const POST = createWebhookHandler(options);
  return (request = webhookRequest()) => POST({ request });
}

function emailOptions(overrides: WebhookHandlerOptions = {}): WebhookHandlerOptions {
  return {
    orderEmailFrom: "orders@example.com",
    orderEmailBcc: "shop@example.com",
    renderOrderEmail: vi.fn().mockReturnValue({
      subject: "ご注文ありがとうございます",
      html: "<p>order</p>",
    }),
    ...overrides,
  };
}

describe("createWebhookHandler", () => {
  beforeEach(() => {
    vi.mocked(getServerEnv).mockReturnValue(env());
    constructEventAsyncMock.mockResolvedValue(stripeEvent());
    listLineItemsMock.mockResolvedValue({
      data: [
        {
          description: "emu クラフト梅シロップ 200ml",
          quantity: 2,
          amount_total: 3000,
        },
      ],
    });
    sendEmailMock.mockResolvedValue({ data: { id: "email_test_mock" }, error: null });
    StripeMock.mockClear();
    ResendMock.mockClear();
    sendEmailMock.mockClear();
    constructEventAsyncMock.mockClear();
    listLineItemsMock.mockClear();
  });

  it("returns OK for GET", async () => {
    const response = await GET({ request: new Request("http://localhost/api/webhook") });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
  });

  it("verifies the Stripe signature and sends an injected order email", async () => {
    const options = emailOptions();
    const postWebhook = createPostWebhook(options);

    const response = await postWebhook();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("OK");
    expect(StripeMock).toHaveBeenCalledWith("sk_test_mock", {
      apiVersion: "2026-05-27.dahlia",
    });
    expect(constructEventAsyncMock).toHaveBeenCalledWith(
      JSON.stringify({ id: "evt_test_mock" }),
      "sig_test",
      "whsec_test",
    );
    expect(listLineItemsMock).toHaveBeenCalledWith("cs_test_mock", { limit: 100 });
    expect(options.renderOrderEmail).toHaveBeenCalledWith({
      name: "テスト 太郎",
      email: "test@example.com",
      phone: "0312345678",
      items: [
        {
          description: "emu クラフト梅シロップ 200ml",
          quantity: 2,
          amount: 3000,
        },
      ],
      totalAmount: 4700,
      shippingCostAmount: 450,
      shipping: {
        name: "テスト 太郎",
        address: {
          country: "JP",
          postal_code: "1500001",
          state: "東京都",
          city: "渋谷区",
          line1: "神宮前1-1-1",
          line2: "101",
        },
      },
      customFields: {},
    });
    expect(ResendMock).toHaveBeenCalledWith("re_test_mock");
    expect(sendEmailMock).toHaveBeenCalledWith({
      from: "orders@example.com",
      to: "test@example.com",
      bcc: "shop@example.com",
      subject: "ご注文ありがとうございます",
      html: "<p>order</p>",
    });
  });

  it("records the order and decrements stock before sending the confirmation email", async () => {
    const recordOrder = vi.fn().mockResolvedValue(undefined);
    const decrementStock = vi.fn().mockResolvedValue(undefined);
    const postWebhook = createPostWebhook(emailOptions({ recordOrder, decrementStock }));

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(recordOrder).toHaveBeenCalledWith({
      id: "cs_test_mock",
      email: "test@example.com",
      name: "テスト 太郎",
      phone: "0312345678",
      items: [{ sku: "200ml", quantity: 2 }],
      amount: 4700,
      shippingCost: 450,
      shippingAddress: {
        name: "テスト 太郎",
        address: {
          country: "JP",
          postal_code: "1500001",
          state: "東京都",
          city: "渋谷区",
          line1: "神宮前1-1-1",
          line2: "101",
        },
      },
      paymentIntent: "pi_test_mock",
      offerSlug: null,
      customFields: null,
      createdAt: expect.any(Number),
    });
    expect(decrementStock).toHaveBeenCalledWith([{ sku: "200ml", quantity: 2 }]);
    expect(recordOrder.mock.invocationCallOrder[0]).toBeLessThan(
      sendEmailMock.mock.invocationCallOrder[0],
    );
  });

  it("normalizes custom fields into the recordOrder and renderOrderEmail payloads", async () => {
    const recordOrder = vi.fn().mockResolvedValue(undefined);
    const options = emailOptions({ recordOrder });
    constructEventAsyncMock.mockResolvedValue(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          custom_fields: [
            { key: "class_name", type: "text", text: { value: " ばら組 " } },
            { key: "child_name", type: "text", text: { value: " 山田花子 " } },
            { key: "message", type: "text", text: { value: " よろしく " } },
          ],
        }),
      ),
    );
    const postWebhook = createPostWebhook(options);

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(recordOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        customFields: {
          class_name: "ばら組",
          child_name: "山田花子",
          message: "よろしく",
        },
      }),
    );
    expect(options.renderOrderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        customFields: {
          class_name: "ばら組",
          child_name: "山田花子",
          message: "よろしく",
        },
      }),
    );
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook(webhookRequest({}));

    expect(response.status).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 400 when signature verification fails", async () => {
    constructEventAsyncMock.mockRejectedValue(new Error("invalid signature"));
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 200 without sending email for ignored events", async () => {
    constructEventAsyncMock.mockResolvedValue(stripeEvent("payment_intent.created"));
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips processing for duplicate events", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const claimEvent = vi.fn().mockResolvedValue(false);
    const recordOrder = vi.fn().mockResolvedValue(undefined);
    const postWebhook = createPostWebhook(emailOptions({ claimEvent, recordOrder }));

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(claimEvent).toHaveBeenCalledWith("evt_test_mock");
    expect(recordOrder).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith("[webhook] duplicate event skipped:", "evt_test_mock");
    consoleLogSpy.mockRestore();
  });

  it("skips deduplication when claimEvent is absent", async () => {
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("records refund and restores stock for a charge.refunded event", async () => {
    constructEventAsyncMock.mockResolvedValue(chargeRefundedEvent());
    const recordRefund = vi.fn().mockResolvedValue({
      items: [{ sku: "200ml", quantity: 2 }],
      offerSlug: "friends-2026",
    });
    const restoreStock = vi.fn().mockResolvedValue(undefined);
    const decrementOfferSold = vi.fn().mockResolvedValue(undefined);
    const postWebhook = createPostWebhook({ recordRefund, restoreStock, decrementOfferSold });

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(recordRefund).toHaveBeenCalledWith("pi_test_mock");
    expect(restoreStock).toHaveBeenCalledWith([{ sku: "200ml", quantity: 2 }]);
    expect(decrementOfferSold).toHaveBeenCalledWith("friends-2026", [
      { sku: "200ml", quantity: 2 },
    ]);
    expect(listLineItemsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("records expiry and restores stock for a checkout.session.expired event", async () => {
    constructEventAsyncMock.mockResolvedValue(stripeEvent("checkout.session.expired"));
    const recordExpiry = vi.fn().mockResolvedValue({
      items: [{ sku: "200ml", quantity: 2 }],
      offerSlug: null,
    });
    const restoreStock = vi.fn().mockResolvedValue(undefined);
    const postWebhook = createPostWebhook({ recordExpiry, restoreStock });

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(recordExpiry).toHaveBeenCalledWith("cs_test_mock");
    expect(restoreStock).toHaveBeenCalledWith([{ sku: "200ml", quantity: 2 }]);
    expect(listLineItemsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips refund state changes when recordRefund is absent", async () => {
    constructEventAsyncMock.mockResolvedValue(chargeRefundedEvent());
    const restoreStock = vi.fn().mockResolvedValue(undefined);
    const postWebhook = createPostWebhook({ restoreStock });

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(restoreStock).not.toHaveBeenCalled();
  });

  it("skips email when customer email is missing", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEventAsyncMock.mockResolvedValue(
      stripeEvent("checkout.session.completed", checkoutSession({ customer_details: { name: "テスト 太郎" } })),
    );
    const options = emailOptions();
    const postWebhook = createPostWebhook(options);

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(options.renderOrderEmail).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("skips email when Resend key is missing", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getServerEnv).mockReturnValue(env({ RESEND_API_KEY: "" }));
    const options = emailOptions();
    const postWebhook = createPostWebhook(options);

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(options.renderOrderEmail).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("skips email when renderOrderEmail is absent", async () => {
    const postWebhook = createPostWebhook({ orderEmailFrom: "orders@example.com" });

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("logs listLineItems failures without the raw provider error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listLineItemsMock.mockRejectedValue({
      name: "StripeAPIError",
      type: "StripeAPIError",
      code: "api_error",
      statusCode: 500,
      requestId: "req_mock",
      message: "list failed",
      headers: { authorization: "secret" },
    });
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith("[webhook] listLineItems failed:", {
      name: "StripeAPIError",
      type: "StripeAPIError",
      code: "api_error",
      statusCode: 500,
      requestId: "req_mock",
      message: "list failed",
    });
    consoleErrorSpy.mockRestore();
  });

  it("returns 200 when Resend returns an error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmailMock.mockResolvedValue({
      data: null,
      error: { name: "ResendError", statusCode: 502, message: "send failed", body: { to: "test@example.com" } },
    });
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("[webhook] Resend error:", {
      name: "ResendError",
      type: undefined,
      code: undefined,
      statusCode: 502,
      requestId: undefined,
      message: "send failed",
    });
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when STRIPE_WEBHOOK_SECRET is not configured", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getServerEnv).mockReturnValue(env({ STRIPE_WEBHOOK_SECRET: "" }));
    const postWebhook = createPostWebhook(emailOptions());

    const response = await postWebhook();

    expect(response.status).toBe(500);
    expect(sendEmailMock).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
