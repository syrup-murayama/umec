import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockResend } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockResend: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: mockResend.mockImplementation(() => ({
    contacts: {
      create: mockCreate,
    },
  })),
}));

vi.mock("./env.js", () => ({
  getServerEnv: vi.fn(),
}));

import { getServerEnv } from "./env.js";
import { createSubscribeHandler } from "./subscribe.js";

const POST_DEV = createSubscribeHandler({ isProduction: false });
const POST_PROD = createSubscribeHandler({ isProduction: true });

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new Request("http://localhost/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function postSubscribe(body: unknown, handler: typeof POST_DEV = POST_DEV) {
  return handler({ request: jsonRequest(body) });
}

async function postSubscribeRaw(body: string, handler: typeof POST_DEV = POST_DEV) {
  return handler({ request: rawRequest(body) });
}

describe("createSubscribeHandler", () => {
  beforeEach(() => {
    vi.mocked(getServerEnv).mockReset();
    mockCreate.mockReset();
    mockResend.mockClear();
  });

  it("returns 200 for a valid email in dev (env not set)", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
      RESEND_AUDIENCE_ID: "",
    });

    const response = await postSubscribe({ email: "test@example.com" }, POST_DEV);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns 503 in production when RESEND env vars are missing", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "",
      RESEND_AUDIENCE_ID: "",
    });

    const response = await postSubscribe({ email: "test@example.com" }, POST_PROD);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Subscription service unavailable" });
  });

  it("returns 400 for an invalid email address", async () => {
    const response = await postSubscribe({ email: "not-an-email" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid email" });
  });

  it("returns 400 for missing email field", async () => {
    const response = await postSubscribe({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid email" });
  });

  it("returns 400 for invalid JSON", async () => {
    const response = await postSubscribeRaw("{invalid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
  });

  it("returns 400 for non-object body", async () => {
    const response = await postSubscribe(null);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
  });

  it("creates a Resend contact when env vars are set", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "re_test",
      RESEND_AUDIENCE_ID: "aud_test",
    });
    mockCreate.mockResolvedValue({ error: null });

    const response = await postSubscribe({ email: "test@example.com" });

    expect(response.status).toBe(200);
    expect(mockResend).toHaveBeenCalledWith("re_test");
    expect(mockCreate).toHaveBeenCalledWith({
      email: "test@example.com",
      audienceId: "aud_test",
      unsubscribed: false,
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns 502 when Resend returns an error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getServerEnv).mockReturnValue({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "re_test",
      RESEND_AUDIENCE_ID: "aud_test",
    });
    mockCreate.mockResolvedValue({
      error: { name: "ResendError", statusCode: 502, message: "failed", body: { email: "test@example.com" } },
    });

    const response = await postSubscribe({ email: "test@example.com" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Subscription failed" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("[subscribe] Resend error:", {
      name: "ResendError",
      type: undefined,
      code: undefined,
      statusCode: 502,
      requestId: undefined,
      message: "failed",
    });
    consoleErrorSpy.mockRestore();
  });

  it("returns 502 when Resend throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getServerEnv).mockReturnValue({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: "re_test",
      RESEND_AUDIENCE_ID: "aud_test",
    });
    mockCreate.mockRejectedValue(new Error("network"));

    const response = await postSubscribe({ email: "test@example.com" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Subscription failed" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("[subscribe] Resend exception:", {
      name: "Error",
      type: undefined,
      code: undefined,
      statusCode: undefined,
      requestId: undefined,
      message: "network",
    });
    consoleErrorSpy.mockRestore();
  });
});
