"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ONBOARDING_STEPS,
  normalizeWebsiteUrl,
  type OnboardingCursor,
  type OnboardingStep,
} from "@tuezday/contracts";
import { apiFetch, getToken } from "@/lib/api";
import { ConnectPanel } from "./_components/connect-panel";
import { VerifyPanel } from "./_components/verify-panel";
import { BrainPanel } from "./_components/brain-panel";
import { CampaignPanel } from "./_components/campaign-panel";
import { DraftPanel } from "./_components/draft-panel";
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

function nextStep(step: OnboardingStep): OnboardingCursor {
  const i = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[i + 1] ?? "done";
}

function OnboardingWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<OnboardingStep>("name");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [wsName, setWsName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) router.push("/login");
  }, [router]);

  // Resume (Sprint 36.5): /onboarding?workspace=<id> jumps to the workspace's
  // stored cursor so a reload never loses progress.
  const resumeId = params.get("workspace");
  useEffect(() => {
    if (!resumeId) return;
    let active = true;
    void (async () => {
      try {
        const [wsRes, meRes] = await Promise.all([
          apiFetch(`/workspaces/${resumeId}`),
          apiFetch("/auth/me"),
        ]);
        if (!wsRes.ok) return;
        const ws = await wsRes.json();
        if (meRes.ok && active) {
          const me = await meRes.json();
          setName(me.user?.name ?? "");
        }
        if (!active) return;
        setWorkspaceId(ws.id);
        setWebsite(ws.websiteUrl ?? "");
        setWsName(ws.name ?? "");
        const cursor = ws.onboardingStep as OnboardingCursor | null;
        if (cursor === "done" || cursor === null) {
          router.push(`/workspaces/${ws.id}`);
          return;
        }
        setStep(cursor);
      } catch {
        // resume is best-effort; the wizard just starts at "name"
      }
    })();
    return () => {
      active = false;
    };
  }, [resumeId, router]);

  // No-friction: a bare domain ("acme.com") is valid — we prepend https://.
  const normalizedUrl = useMemo(() => normalizeWebsiteUrl(website), [website]);
  const validUrl = normalizedUrl !== null;

  /** Advance the cursor server-side, then locally. Surfaces the 36.3 min-1
   * social gate's 409 (and any other rejection) on the wizard error line. */
  const advance = useCallback(async () => {
    if (!workspaceId) return;
    const to = nextStep(step);
    setError(null);
    const res = await apiFetch(`/workspaces/${workspaceId}/onboarding`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: to }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.message ?? "Could not continue");
      return;
    }
    if (to === "done") {
      router.push(`/workspaces/${workspaceId}`);
      return;
    }
    setStep(to as OnboardingStep);
  }, [workspaceId, step, router]);

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
          websiteUrl: normalizedUrl ?? website.trim(),
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

  const panelProps = workspaceId
    ? {
        workspaceId,
        userName: name.trim(),
        onContinue: advance,
        onError: setError,
        campaignId,
        onCampaignCreated: setCampaignId,
        workspaceName: wsName,
      }
    : null;

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
            Just the domain is fine — e.g. acme.com. We&apos;ll read it the moment you continue and draft your Brain from it.
          </p>
          <input
            className="ob-input"
            value={website}
            onChange={(e) => {
              setWebsite(e.target.value);
              if (!wsName) setWsName(nameFromHost(e.target.value));
            }}
            placeholder="acme.com"
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

      {step === "connect" && panelProps && <ConnectPanel {...panelProps} />}
      {step === "verify" && panelProps && <VerifyPanel {...panelProps} />}
      {step === "brain" && panelProps && <BrainPanel {...panelProps} />}

      {step === "campaign" && panelProps && <CampaignPanel {...panelProps} />}
      {step === "draft" && panelProps && <DraftPanel {...panelProps} />}
    </main>
  );
}

export default function OnboardingPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}
