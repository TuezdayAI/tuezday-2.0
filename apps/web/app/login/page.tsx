"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setToken } from "@/lib/api";

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
        if (body?.error === "invalid_credentials") throw new Error("Wrong email or password.");
        if (body?.error === "email_taken") throw new Error("That email already has an account — log in instead.");
        throw new Error(body?.message ?? `API returned ${res.status}`);
      }
      setToken(body.token);
      router.push(searchParams.get("next") ?? "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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
        <h1>{mode === "login" ? "Log in" : "Create your account"}</h1>
        <p className="subtitle">
          {mode === "login" ? (
            <>
              New here?{" "}
              <button type="button" className="link-button" onClick={() => setMode("register")}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" className="link-button" onClick={() => setMode("login")}>
                Log in
              </button>
            </>
          )}
        </p>

        <form className="create-form auth-form" onSubmit={submit}>
          {mode === "register" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              maxLength={100}
              autoComplete="name"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
          <button type="submit" disabled={submitting || !email || !password}>
            {mode === "login" ? "Log in" : "Sign up"}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
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
