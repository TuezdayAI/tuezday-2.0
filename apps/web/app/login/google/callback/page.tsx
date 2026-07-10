"use client";

import { Suspense, useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setToken } from "@/lib/api";
import styles from "./callback.module.css";

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
      <>
        <header className="site-header">
          <span className="logo">Tuezday</span>
          <span className="tagline">GTM that remembers</span>
        </header>
        <main className="site-main">
          <div className={styles.card}>
            <h1>Google sign-in didn&apos;t finish</h1>
            <p className="error">{error}</p>
            <p className={styles.waiting}>
              Head back to the login page and try again — or sign in with your email and password
              instead.
            </p>
            <div className={styles.actions}>
              <Button variant="primary" onClick={() => router.push("/login")}>
                Return to login
              </Button>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <header className="site-header">
        <span className="logo">Tuezday</span>
        <span className="tagline">GTM that remembers</span>
      </header>
      <main className="site-main">
        <div className={styles.card}>
          <h1>Signing you in…</h1>
          <p className={styles.waiting}>Finishing Google sign-in — one moment.</p>
        </div>
      </main>
    </>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense>
      <CallbackHandler />
    </Suspense>
  );
}
