import type { GoogleProfile } from "@tuezday/contracts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

export type GoogleAuthErrorCode =
  | "not_configured"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "email_unverified";

export class GoogleAuthError extends Error {
  constructor(public readonly code: GoogleAuthErrorCode, message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/login/google/callback";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

export function googleAuthUrl(state: string): string {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleAuthError("not_configured", "Google login is not configured.");
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCodeForProfile(
  fetcher: typeof fetch,
  code: string,
): Promise<GoogleProfile> {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleAuthError("not_configured", "Google login is not configured.");

  const tokenRes = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new GoogleAuthError("token_exchange_failed", `Google token exchange failed (${tokenRes.status}).`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new GoogleAuthError("token_exchange_failed", "Google returned no access token.");
  }

  const infoRes = await fetcher(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) {
    throw new GoogleAuthError("userinfo_failed", `Google userinfo failed (${infoRes.status}).`);
  }
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!info.email_verified || !info.email || !info.sub) {
    throw new GoogleAuthError("email_unverified", "Google account email is not verified.");
  }
  return {
    sub: info.sub,
    email: info.email.toLowerCase(),
    emailVerified: true,
    name: info.name ?? "",
  };
}
