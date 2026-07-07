"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ONBOARDING_STEPS, type OnboardingStep } from "@tuezday/contracts";
import { apiFetch, getToken } from "@/lib/api";
import "./onboarding.css";

const STEP_LABELS: Record<OnboardingStep, string> = {
  name: "You",
  website: "Website",
  connect: "Socials",
  verify: "Verify",
  brain: "Your Brain",
  campaign: "Campaign",
  draft: "First draft",
};

/** "https://www.hexalog.com/x" → "Hexalog" — a friendly default workspace name. */
function nameFromHost(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const bare = host.split(".")[0] ?? host;
    return bare.charAt(0).toUpperCase() + bare.slice(1);
  } catch {
    return "";
  }
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>("name");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [wsName, setWsName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) router.push("/login");
  }, [router]);

  const validUrl = useMemo(() => {
    try {
      const u = new URL(website);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, [website]);

  async function saveName() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Could not save your name");
      }
      setStep("website");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: (wsName || nameFromHost(website) || "My workspace").trim(),
          websiteUrl: website.trim(),
          onboardingStep: "connect",
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? "Could not create the workspace");
      setWorkspaceId(body.id);
      setStep("connect");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding">
      <ol className="ob-rail">
        {ONBOARDING_STEPS.map((s) => (
          <li key={s} className={`ob-rail-step ${s === step ? "active" : ""}`}>
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      {name.trim() && step !== "name" && (
        <p className="ob-greeting">Nice to meet you, {name.trim()}.</p>
      )}
      {error && <p className="error">{error}</p>}

      {step === "name" && (
        <section className="panel ob-panel">
          <h1>Welcome to Tuezday</h1>
          <p className="subtitle">First — what should we call you?</p>
          <input
            className="ob-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy && name.trim()) void saveName();
            }}
            placeholder="Your name"
            maxLength={100}
            autoFocus
          />
          <div className="ob-actions">
            <span />
            <button disabled={busy || name.trim().length === 0} onClick={saveName}>
              {busy ? "Saving…" : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step === "website" && (
        <section className="panel ob-panel">
          <h1>Point us at your website</h1>
          <p className="subtitle">
            We&apos;ll read it to draft your Brain. (Reading arrives in a later sprint — for
            now we remember the URL.)
          </p>
          <input
            className="ob-input"
            value={website}
            onChange={(e) => {
              setWebsite(e.target.value);
              if (!wsName) setWsName(nameFromHost(e.target.value));
            }}
            placeholder="https://acme.com"
            autoFocus
          />
          <input
            className="ob-input"
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="Workspace name"
            maxLength={100}
          />
          <div className="ob-actions">
            <button type="button" className="link-button" onClick={() => setStep("name")}>
              Back
            </button>
            <button disabled={busy || !validUrl} onClick={createWorkspace}>
              {busy ? "Creating…" : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step !== "name" && step !== "website" && (
        <section className="panel ob-panel">
          <h1>{STEP_LABELS[step]}</h1>
          <p className="subtitle">Coming up in a later sprint.</p>
          {workspaceId && (
            <Link className="link-button" href={`/workspaces/${workspaceId}`}>
              Skip to workspace →
            </Link>
          )}
        </section>
      )}
    </main>
  );
}
