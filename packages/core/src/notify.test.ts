import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, mockResend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockResend: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: mockResend.mockImplementation(() => ({
    emails: {
      send: mockSend,
    },
  })),
}));

import { notifyUnshipped } from "./notify.js";

describe("notifyUnshipped", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockSend.mockReset();
    mockResend.mockReset();
    mockResend.mockImplementation(() => ({
      emails: {
        send: mockSend,
      },
    }));
  });

  it("does nothing when there are no orders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await notifyUnshipped([], {}, { alertFrom: "emu alerts <order@muraya.ma>", alertTo: "studio@muraya.ma" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockResend).not.toHaveBeenCalled();
  });

  it("builds Discord and Resend notifications with injected product names", async () => {
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    mockSend.mockResolvedValue({ error: null });

    await notifyUnshipped(
      [
        {
          id: "order_1",
          name: "  山田 <太郎>  ",
          items_json: JSON.stringify([{ sku: "ume-001", quantity: 2 }]),
          amount: 5400,
          created_at: Date.parse("2026-07-02T00:00:00.000Z"),
        },
      ],
      {
        DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
        RESEND_API_KEY: "re_test",
      },
      {
        alertFrom: "emu alerts <order@muraya.ma>",
        alertTo: "studio@muraya.ma",
        products: {
          "ume-001": { name: "梅シロップ" },
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith("https://discord.example/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "未発送アラート: pending の注文があります。\n\n山田 <太郎> | 梅シロップ x 2 | ￥5,400 | 3日",
        allowed_mentions: { parse: [] },
      }),
    });
    expect(mockResend).toHaveBeenCalledWith("re_test");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "emu alerts <order@muraya.ma>",
        to: "studio@muraya.ma",
        subject: "【emu】未発送アラート",
        text: "未発送アラート: pending の注文があります。\n\n山田 <太郎> | 梅シロップ x 2 | ￥5,400 | 3日",
        html: expect.stringContaining("山田 &lt;太郎&gt;"),
      }),
    );
  });

  it("throws when Discord notification fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    await expect(
      notifyUnshipped(
        [{ id: "order_1", name: null, items_json: null, amount: null, created_at: null }],
        { DISCORD_WEBHOOK_URL: "https://discord.example/webhook", RESEND_API_KEY: "re_test" },
        { alertFrom: "emu alerts <order@muraya.ma>", alertTo: "studio@muraya.ma" },
      ),
    ).rejects.toThrow("Discord notification failed: 500");
    expect(mockResend).not.toHaveBeenCalled();
  });

  it("throws when Resend returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    mockSend.mockResolvedValue({ error: { name: "ResendError", statusCode: 502, message: "failed" } });

    await expect(
      notifyUnshipped(
        [{ id: "order_1", name: null, items_json: null, amount: null, created_at: null }],
        { DISCORD_WEBHOOK_URL: "https://discord.example/webhook", RESEND_API_KEY: "re_test" },
        { alertFrom: "emu alerts <order@muraya.ma>", alertTo: "studio@muraya.ma" },
      ),
    ).rejects.toThrow("Resend notification failed (name=ResendError, statusCode=502)");
  });
});
