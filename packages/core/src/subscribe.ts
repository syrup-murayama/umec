import { Resend } from "resend";
import { getServerEnv } from "./env.js";

export type SubscribeHandler = ({ request }: { request: Request }) => Promise<Response>;

export type SubscribeHandlerOptions = {
  isProduction: boolean;
};

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

export function createSubscribeHandler({ isProduction }: SubscribeHandlerOptions): SubscribeHandler {
  return async ({ request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid request body", 400);
    }

    if (typeof body !== "object" || body === null) {
      return jsonError("Invalid request body", 400);
    }

    const { email } = body as Record<string, unknown>;

    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonError("Invalid email", 400);
    }

    const { RESEND_API_KEY: apiKey, RESEND_AUDIENCE_ID: audienceId } = getServerEnv();

    if (!apiKey || !audienceId) {
      if (isProduction) {
        console.error("[subscribe] RESEND env missing in production");
        return jsonError("Subscription service unavailable", 503);
      }
      console.log("[subscribe] env not set (dev), skipping:", email);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const resend = new Resend(apiKey);
      const { error } = await resend.contacts.create({ email, audienceId, unsubscribed: false });
      if (error) {
        console.error("[subscribe] Resend error:", providerErrorDetails(error));
        return jsonError("Subscription failed", 502);
      }
    } catch (e) {
      console.error("[subscribe] Resend exception:", providerErrorDetails(e));
      return jsonError("Subscription failed", 502);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
