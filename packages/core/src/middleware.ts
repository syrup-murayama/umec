const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// Astro の ValidRedirectStatus と同一のユニオンに揃える。
// number に広げると Astro の APIContext が strict モードで代入不能になる（TS2345）
export type UmecRedirectStatus = 300 | 301 | 302 | 303 | 304 | 307 | 308;

export type UmecMiddlewareContext = {
  url: URL;
  redirect: (path: string, status?: UmecRedirectStatus) => Response;
};

export type UmecMiddlewareNext = () => Response | Promise<Response>;

export type UmecMiddleware = (context: UmecMiddlewareContext, next: UmecMiddlewareNext) => Promise<Response>;

export type UmecLimitedPage = {
  pathPrefix: string;
  expiresAt: number;
};

export type UmecMiddlewareOptions = {
  maintenanceMode: boolean;
  limitedPages?: UmecLimitedPage[];
};

function withSecurityHeaders(response: Response) {
  const securedResponse = new Response(response.body, response);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    securedResponse.headers.set(name, value);
  }

  return securedResponse;
}

export function createUmecMiddleware({ maintenanceMode, limitedPages = [] }: UmecMiddlewareOptions): UmecMiddleware {
  return async (context, next) => {
    const path = context.url.pathname;

    const limitedPage = limitedPages.find(({ pathPrefix }) => path === pathPrefix || path.startsWith(`${pathPrefix}/`));
    if (limitedPage && Date.now() > limitedPage.expiresAt) {
      return withSecurityHeaders(
        new Response("Not found", {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
          },
        }),
      );
    }

    if (maintenanceMode && path !== "/maintenance" && !path.startsWith("/api/")) {
      const response = context.redirect("/maintenance", 302);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    return withSecurityHeaders(await next());
  };
}
