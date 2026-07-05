import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUmecMiddleware, type UmecMiddlewareContext } from "./middleware.js";

function context(pathname: string): UmecMiddlewareContext {
  return {
    url: new URL(`https://example.com${pathname}`),
    redirect: (path, status) =>
      new Response(null, {
        status,
        headers: {
          Location: path,
        },
      }),
  };
}

describe("createUmecMiddleware", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("adds security headers to normal responses", async () => {
    const onRequest = createUmecMiddleware({ maintenanceMode: false });

    const response = await onRequest(context("/"), () => new Response("ok"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("returns 404 with security headers for expired limited docs", async () => {
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const onRequest = createUmecMiddleware({ maintenanceMode: false });
    const next = vi.fn(() => new Response("ok"));

    const response = await onRequest(context("/docs/asahiko2026special"), next);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(next).not.toHaveBeenCalled();
  });

  it("redirects to maintenance when maintenance mode is enabled", async () => {
    const onRequest = createUmecMiddleware({ maintenanceMode: true });
    const next = vi.fn(() => new Response("ok"));

    const response = await onRequest(context("/shop"), next);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/maintenance");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("does not redirect maintenance page or api paths", async () => {
    const onRequest = createUmecMiddleware({ maintenanceMode: true });

    const maintenanceResponse = await onRequest(context("/maintenance"), () => new Response("maintenance"));
    const apiResponse = await onRequest(context("/api/subscribe"), () => new Response("api"));

    expect(maintenanceResponse.status).toBe(200);
    expect(await maintenanceResponse.text()).toBe("maintenance");
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.text()).toBe("api");
  });
});
