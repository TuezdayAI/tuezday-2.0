"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setToken } from "@/lib/api";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { BrandIcon } from "@/src/components/ui/icon";
import styles from "./login.module.css";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "register" ? { email, password, name } : { email, password },
        ),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.error === "invalid_credentials")
          throw new Error("Wrong email or password. Check for typos — or create an account if you're new here.");
        if (body?.error === "email_taken")
          throw new Error("That email already has an account — log in instead.");
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setToken(body.token);
      router.push(searchParams.get("next") ?? "/");
    } catch (err) {
      setError(
        err instanceof Error && err.message !== "Failed to fetch"
          ? err.message
          : "Could not reach the server. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  async function startGoogleAuth() {
    setSubmitting(true);
    setError(null);
    try {
      const nextUrl = searchParams.get("next") ?? "/";
      const res = await fetch(`${API_URL}/auth/google/url?state=${encodeURIComponent(nextUrl)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      window.location.assign(body.url);
    } catch (err) {
      setError(
        err instanceof Error && err.message !== "Failed to fetch"
          ? err.message
          : "Could not start Google sign-in. Check your connection and try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <span className="logo">Tuezday</span>
        <span className="tagline">GTM that remembers</span>
      </header>
      <main className="site-main">
        <div className={styles.card}>
          <h1>{mode === "login" ? "Log in" : "Create your account"}</h1>
          <p className={styles.switchRow}>
            {mode === "login" ? (
              <>
                New here?{" "}
                <Button type="button" variant="ghost" size="sm" onClick={() => setMode("register")}>
                  Create an account
                </Button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <Button type="button" variant="ghost" size="sm" onClick={() => setMode("login")}>
                  Log in
                </Button>
              </>
            )}
          </p>

          <form className="create-form auth-form" onSubmit={submit}>
            {mode === "register" && (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                maxLength={100}
                autoComplete="name"
              />
            )}
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              minLength={mode === "register" ? 8 : undefined}
              required
            />
            <Button variant="primary" type="submit" disabled={submitting || !email || !password}>
              {mode === "login" ? "Log in" : "Sign up"}
            </Button>
          </form>

          <div className={styles.divider}>
            <span>or</span>
          </div>

          <button
            type="button"
            className={styles.googleButton}
            onClick={startGoogleAuth}
            disabled={submitting}
          >
            <BrandIcon name="google" size="sm" brandColor aria-label="Google" />
            Continue with Google
          </button>

          {error && <p className={`error ${styles.error}`}>{error}</p>}
        </div>
      </main>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
