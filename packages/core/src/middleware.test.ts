import { describe, expect, it, vi } from "vitest";

import {
  createUmecMiddleware,
  type UmecLimitedPage,
  type UmecMiddlewareContext,
} from "./middleware.js";

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

  it("returns 404 for an expired injected limited page", async () => {
    const limitedPages = [
      { pathPrefix: "/campaign", expiresAt: Date.now() - 1 },
    ] satisfies UmecLimitedPage[];
    const onRequest = createUmecMiddleware({ maintenanceMode: false, limitedPages });
    const next = vi.fn(() => new Response("ok"));

    const response = await onRequest(context("/campaign/landing"), next);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a limited page before expiry and does not match a similar prefix", async () => {
    const limitedPages = [
      { pathPrefix: "/campaign", expiresAt: Number.MAX_SAFE_INTEGER },
    ] satisfies UmecLimitedPage[];
    const onRequest = createUmecMiddleware({ maintenanceMode: false, limitedPages });

    const pageResponse = await onRequest(context("/campaign"), () => new Response("campaign"));
    const similarPrefixResponse = await onRequest(context("/campaign-archive"), () => new Response("archive"));

    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toBe("campaign");
    expect(similarPrefixResponse.status).toBe(200);
    expect(await similarPrefixResponse.text()).toBe("archive");
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
