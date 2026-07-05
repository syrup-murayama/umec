import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

import { getServerEnv } from "./env.js";

const fullEnv = {
  PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_example",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  RESEND_API_KEY: "re_example",
  RESEND_AUDIENCE_ID: "aud_example",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/example",
  ALERT_DAYS_THRESHOLD: "3",
  DB: { prepare: vi.fn() },
};

describe("getServerEnv", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockEnv)) {
      delete mockEnv[key];
    }
  });

  it("returns all variables when env is fully populated", () => {
    Object.assign(mockEnv, fullEnv);

    expect(getServerEnv()).toEqual(fullEnv);
  });

  it("returns env as-is when required secrets are missing (no runtime validation)", () => {
    Object.assign(mockEnv, {
      PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_only",
    });

    const result = getServerEnv();

    expect(result.PUBLIC_STRIPE_PUBLISHABLE_KEY).toBe("pk_test_only");
    expect(result.STRIPE_SECRET_KEY).toBeUndefined();
    expect(result.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(result.RESEND_API_KEY).toBeUndefined();
    expect(result.RESEND_AUDIENCE_ID).toBeUndefined();
  });
});
