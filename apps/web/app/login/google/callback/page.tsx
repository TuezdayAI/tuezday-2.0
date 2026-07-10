"use client";

import { Suspense, useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setToken } from "@/lib/api";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const errorParam = searchParams.get("error");
    const state = searchParams.get("state");

    if (errorParam) {
      setError(`Google login failed: ${errorParam}`);
      return;
    }
    if (!code) {
      setError("No authorization code provided by Google.");
      return;
    }

    let mounted = true;

    async function exchangeCode() {
      try {
        const res = await fetch(`${API_URL}/auth/google/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const body = await res.json().catch(() => null);

        if (!mounted) return;

        if (!res.ok) {
          if (body?.error === "email_unverified") {
            setError("Your Google account email is not verified. Please use another account.");
          } else if (body?.error === "google_not_configured") {
            setError("Google login is not configured on this server.");
          } else {
            setError(body?.message ?? `API returned ${res.status}`);
          }
          return;
        }

        setToken(body.token);
        router.push(state || "/");
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Network error during login");
        }
      }
    }

    exchangeCode();

    return () => {
      mounted = false;
    };
  }, [router, searchParams]);

  if (error) {
    return (
      <main className="site-main">
        <h1>Login failed</h1>
        <p className="error">{error}</p>
        <Button variant="ghost" size="sm" onClick={() => router.push("/login")} style={{ marginTop: "1rem" }}>
          Return to login
        </Button>
      </main>
    );
  }

  return (
    <main className="site-main">
      <div style={{ textAlign: "center", padding: "3rem" }}>
        <p>Logging you in...</p>
      </div>
    </main>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense>
      <CallbackHandler />
    </Suspense>
  );
}
