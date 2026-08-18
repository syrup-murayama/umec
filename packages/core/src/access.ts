import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface AccessGuardOptions {
  teamDomain: string;
  aud: string;
  getKey?: JWTVerifyGetKey;
}

export type AccessGuardResult =
  | { ok: true; payload: JWTPayload }
  | { ok: false; status: 403; error: string };

export function createAccessGuard(options: AccessGuardOptions) {
  const { teamDomain, aud } = options;

  if (teamDomain === "") {
    throw new Error("teamDomain is required");
  }

  if (aud === "") {
    throw new Error("aud is required");
  }

  const issuer = `https://${teamDomain}`;
  const getKey =
    options.getKey ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async function guard(request: Request): Promise<AccessGuardResult> {
    const token = request.headers.get("cf-access-jwt-assertion");

    if (token === null) {
      return { ok: false, status: 403, error: "Missing Access token" };
    }

    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience: aud,
        algorithms: ["RS256"],
      });

      return { ok: true, payload };
    } catch {
      return { ok: false, status: 403, error: "Invalid Access token" };
    }
  };
}
