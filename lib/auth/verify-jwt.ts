import * as jose from "jose";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getProjectJwks } from "@/lib/auth/jwks-cache";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";

let verifier: SupabaseClient | null = null;

export type VerifiedTokenUser = {
  id: string;
  email?: string;
};

function getVerifier(): SupabaseClient {
  if (!verifier) {
    verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return verifier;
}

function claimsToUser(claims: jose.JWTPayload): VerifiedTokenUser | null {
  if (!claims.sub) return null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
  };
}

/** Verify a Supabase access token locally via getClaims (JWKS) — no Auth API round-trip. */
export async function verifyAccessToken(token: string): Promise<VerifiedTokenUser | null> {
  // Legacy HS256 projects only.
  if (JWT_SECRET) {
    try {
      const secret = new TextEncoder().encode(JWT_SECRET);
      const { payload } = await jose.jwtVerify(token, secret, {
        algorithms: ["HS256"],
        audience: "authenticated",
      });
      return claimsToUser(payload);
    } catch {
      return null;
    }
  }

  // A malformed token can make getClaims throw instead of returning an error: that is a 401, not a 500.
  try {
    const jwks = await getProjectJwks();
    const { data, error } = await getVerifier().auth.getClaims(
      token,
      jwks.keys.length ? { jwks } : {},
    );
    if (error || !data?.claims) return null;
    return claimsToUser(data.claims);
  } catch {
    return null;
  }
}
