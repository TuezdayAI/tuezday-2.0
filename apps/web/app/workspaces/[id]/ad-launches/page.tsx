"use client";

import { PageHeader } from "@/src/components/page-header";
import { EmptyState } from "@/src/components/empty-state";


import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  AD_LAUNCH_OBJECTIVE_LABELS,
  AD_LAUNCH_OBJECTIVES,
  parseAdCreative,
  type AdLaunch,
  type AdLaunchDecision,
  type AdLaunchObjective,
  type AdLaunchStatus,
  type Campaign,
  type Draft,
  type ExternalActionSubmission,
  type MetaAdSetState,
  type Workspace,
} from "@tuezday/contracts";
import {
  actionAuthorizationHref,
  budgetChangeDiff,
  effectivePolicyWorkflowStatus,
  externalActionHref,
  externalActionWorkflowStatus,
  policyExplanation,
  submissionNote,
  targetingChangeDiff,
} from "@/lib/external-actions";
import { reviewHref } from "@/lib/review-workspace";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { CountBadge, WorkflowStatusBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Input, Select } from "@/src/components/ui/input";
import styles from "./ad-launches.module.css";

interface AccountView {
  id: string;
  name: string;
  currency: string;
  connectionId: string | null;
  connectionStatus: string | null;
}

interface CreativeFields {
  primaryText: string;
  headline: string;
  description: string;
}

interface LaunchView extends AdLaunch {
  account: { name: string; currency: string } | null;
  creative: CreativeFields | null;
}

interface LaunchDetail extends LaunchView {
  decisions: AdLaunchDecision[];
}

interface AdSettings {
  dailyCapCents: number;
  killSwitch: boolean;
}

type MutationKind = "budget" | "targeting";

interface MutationFormState {
  launchId: string;
  kind: MutationKind;
  provider: MetaAdSetState;
  beforeDailyBudgetCents: number;
  budgetInput: string;
  countriesInput: string;
  ageMinInput: string;
  ageMaxInput: string;
  idempotencyKey: string;
  submission: ExternalActionSubmission | null;
}

/** An approved Meta creative the founder can build a launch from. */
interface ApprovedCreative {
  draftId: string;
  campaignId: string | null;
  campaignName: string | null;
  primaryText: string;
  headline: string;
}

const STATUS_LABELS: Record<AdLaunchStatus, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  launched: "Launched",
};

function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Platform status under which a launched campaign is not actually spending. */
const PAUSED_PLATFORM = new Set([
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "DELETED",
  "DISAPPROVED",
]);

function isSpending(launch: AdLaunch): boolean {
  return launch.status === "launched" && !PAUSED_PLATFORM.has(launch.platformStatus ?? "ACTIVE");
}

function creativeFrom(content: string): CreativeFields | null {
  const parsed = parseAdCreative("meta_ad_creative", content);
  if (!parsed) return null;
  const value = (key: string) => parsed.fields.find((f) => f.key === key)?.value ?? "";
  const primaryText = value("primary_text");
  const headline = value("headline");
  if (!primaryText || !headline) return null;
  return { primaryText, headline, description: value("description") };
}

export default function AdLaunchesPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const openedRecovery = useRef(false);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [creatives, setCreatives] = useState<ApprovedCreative[]>([]);
  const [launches, setLaunches] = useState<LaunchView[]>([]);
  const [settings, setSettings] = useState<AdSettings | null>(null);
  const [detail, setDetail] = useState<Record<string, LaunchDetail>>({});
  const [launchSubmissions, setLaunchSubmissions] = useState<
    Record<string, ExternalActionSubmission>
  >({});
  const [mutation, setMutation] = useState<MutationFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // settings controls
  const [capInput, setCapInput] = useState("");

  // new launch form
  const [form, setForm] = useState({
    adAccountId: "",
    creativeDraftId: "",
    name: "",
    objective: "OUTCOME_TRAFFIC" as AdLaunchObjective,
    pageId: "",
    linkUrl: "",
    dailyBudget: "5.00",
    countries: "US",
    ageMin: "18",
    ageMax: "65",
  });

  const load = useCallback(async () => {
    try {
      const [wsRes, accRes, cpRes, draftsRes, launchesRes, settingsRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/ads/accounts`),
        apiFetch(`/workspaces/${id}/campaigns`),
        apiFetch(`/workspaces/${id}/drafts?state=approved`),
        apiFetch(`/workspaces/${id}/ads/launches`),
        apiFetch(`/workspaces/${id}/ads/settings`),
      ]);
      if (!wsRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const accountList: AccountView[] = await accRes.json();
      setAccounts(accountList);
      const campaignList: Campaign[] = await cpRes.json();
      setCampaigns(campaignList);
      const campaignName = new Map(campaignList.map((c) => [c.id, c.name]));
      const approvedDrafts: Draft[] = await draftsRes.json();
      setCreatives(
        approvedDrafts
          .filter((d) => d.taskType === "meta_ad_creative")
          .map((d) => {
            const fields = creativeFrom(d.content);
            return fields
              ? {
                  draftId: d.id,
                  campaignId: d.campaignId,
                  campaignName: d.campaignId ? (campaignName.get(d.campaignId) ?? null) : null,
                  primaryText: fields.primaryText,
                  headline: fields.headline,
                }
              : null;
          })
          .filter((c): c is ApprovedCreative => c !== null),
      );
      setLaunches(await launchesRes.json());
      const s = await settingsRes.json();
      setSettings(s);
      setCapInput((s.dailyCapCents / 100).toFixed(2));
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (openedRecovery.current || launches.length === 0) return;
    const launchId = searchParams.get("launch");
    const kind = searchParams.get("mutation");
    if (!launchId || (kind !== "budget" && kind !== "targeting")) return;
    const launch = launches.find((candidate) => candidate.id === launchId);
    if (!launch || launch.status !== "launched") return;
    openedRecovery.current = true;
    void openMutation(launch, kind, true);
  }, [launches, searchParams]);

  const connectedAccounts = useMemo(
    () => accounts.filter((a) => a.connectionId && a.connectionStatus === "connected"),
    [accounts],
  );

  /** Sum of daily budgets currently committed to spending launches. */
  const committedCents = useMemo(
    () => launches.filter(isSpending).reduce((sum, l) => sum + l.dailyBudgetCents, 0),
    [launches],
  );

  async function call(method: string, path: string, payload?: Record<string, unknown>) {
    const res = await apiFetch(`/workspaces/${id}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
    return body;
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function openMutation(launch: LaunchView, kind: MutationKind, forceRefresh = false) {
    if (!forceRefresh && mutation?.launchId === launch.id && mutation.kind === kind) {
      setMutation(null);
      return;
    }
    await run(async () => {
      const provider = (await call(
        "GET",
        `/ads/launches/${launch.id}/provider-state`,
      )) as MetaAdSetState;
      setMutation({
        launchId: launch.id,
        kind,
        provider,
        beforeDailyBudgetCents: provider.dailyBudgetCents,
        budgetInput: (provider.dailyBudgetCents / 100).toFixed(2),
        countriesInput: provider.countries.join(", "),
        ageMinInput: String(provider.ageMin),
        ageMaxInput: String(provider.ageMax),
        idempotencyKey: crypto.randomUUID(),
        submission: null,
      });
    });
  }

  function editMutation(patch: Partial<MutationFormState>) {
    setMutation((current) => {
      if (!current) return current;
      return {
        ...current,
        ...patch,
        idempotencyKey: current.submission ? crypto.randomUUID() : current.idempotencyKey,
        submission: null,
      };
    });
  }

  async function proposeMutation() {
    if (!mutation) return;
    await run(async () => {
      const path = `/ads/launches/${mutation.launchId}/${mutation.kind}-change`;
      const payload =
        mutation.kind === "budget"
          ? {
              dailyBudgetCents: Math.round(Number(mutation.budgetInput) * 100),
              idempotencyKey: mutation.idempotencyKey,
            }
          : {
              countries: mutation.countriesInput
                .split(",")
                .map((country) => country.trim().toUpperCase())
                .filter(Boolean),
              ageMin: Number(mutation.ageMinInput),
              ageMax: Number(mutation.ageMaxInput),
              idempotencyKey: mutation.idempotencyKey,
            };
      const response = await apiFetch(`/workspaces/${id}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok && !body?.action) {
        throw new Error(body?.message ?? body?.error ?? `API returned ${response.status}`);
      }
      const submission: ExternalActionSubmission =
        body.execution !== undefined
          ? (body as ExternalActionSubmission)
          : { action: body.action, execution: body.action.execution ?? null };
      setMutation((current) =>
        current?.launchId === mutation.launchId ? { ...current, submission } : current,
      );
      setNote(submissionNote(submission));
      await load();
    });
  }

  async function saveCap() {
    await run(async () => {
      const cents = Math.round(Number(capInput) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error("Enter a valid daily cap.");
      await call("PUT", "/ads/settings", { dailyCapCents: cents });
      setNote("Daily cap updated.");
      await load();
    });
  }

  async function toggleKillSwitch() {
    if (!settings) return;
    const turningOn = !settings.killSwitch;
    if (turningOn && !window.confirm("Pause every live campaign and block new launches?")) return;
    await run(async () => {
      const result = await call("PUT", "/ads/settings", { killSwitch: turningOn });
      if (turningOn) {
        const failed = (result.paused ?? []).filter((p: { ok: boolean }) => !p.ok).length;
        setNote(
          `Kill switch on — ${(result.paused ?? []).length} campaign(s) paused` +
            (failed ? `, ${failed} could not be reached` : "") +
            ".",
        );
      } else {
        setNote("Kill switch off — launching is allowed again.");
      }
      await load();
    });
  }

  async function createLaunch() {
    await run(async () => {
      const cents = Math.round(Number(form.dailyBudget) * 100);
      const payload = {
        adAccountId: form.adAccountId || connectedAccounts[0]?.id,
        creativeDraftId: form.creativeDraftId,
        name: form.name.trim(),
        objective: form.objective,
        pageId: form.pageId.trim(),
        linkUrl: form.linkUrl.trim(),
        dailyBudgetCents: cents,
        countries: form.countries
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        ageMin: Number(form.ageMin),
        ageMax: Number(form.ageMax),
      };
      await call("POST", "/ads/launches", payload);
      setNote("Launch created as a draft — submit it for approval below.");
      setForm((f) => ({ ...f, name: "", creativeDraftId: "" }));
      await load();
    });
  }

  async function act(launch: LaunchView, action: string, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    await run(async () => {
      if (action === "launch") {
        const res = await apiFetch(`/workspaces/${id}/ads/launches/${launch.id}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const body = await res.json().catch(() => null);
        if (!res.ok && !body?.action) {
          throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
        }
        // A stale 409 carries the durable action but omits the execution
        // envelope. Preserve it so the launch still has an honest recovery UI.
        const submission: ExternalActionSubmission =
          body.execution !== undefined
            ? (body as ExternalActionSubmission)
            : { action: body.action, execution: body.action.execution ?? null };
        setLaunchSubmissions((previous) => ({ ...previous, [launch.id]: submission }));
        setNote(submissionNote(submission));
      } else {
        await call("POST", `/ads/launches/${launch.id}/${action}`, {});
      }
      await load();
      if (detail[launch.id]) await loadDetail(launch.id);
    });
  }

  async function remove(launch: LaunchView) {
    if (!window.confirm(`Delete ad launch "${launch.name}"?`)) return;
    await run(async () => {
      await call("DELETE", `/ads/launches/${launch.id}`);
      await load();
    });
  }

  async function loadDetail(launchId: string) {
    const res = await apiFetch(`/workspaces/${id}/ads/launches/${launchId}`);
    if (!res.ok) return;
    const body: LaunchDetail = await res.json();
    setDetail((d) => ({ ...d, [launchId]: body }));
  }

  function toggleDetail(launchId: string) {
    if (detail[launchId]) {
      setDetail((d) => {
        const next = { ...d };
        delete next[launchId];
        return next;
      });
    } else {
      void loadDetail(launchId);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }
  if (!workspace || !settings) return <EmptyState description="Loading…" />;

  const capCents = settings.dailyCapCents;
  const meterPct = capCents > 0 ? Math.min(100, Math.round((committedCents / capCents) * 100)) : 0;

  return (
    <>
      <PageHeader
        title="Launch ads"
        subtitle="Assemble a campaign from an approved creative, send it through the approval gate, then launch it on Meta. Spend is gated and capped — nothing goes live without a green light."
      />

      {note && <p className="section-reason">{note}</p>}
      {error && <p className="error">{error}</p>}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="warning" size="sm" />
              Spend guardrails
            </span>
          }
          actions={
            <span className={`layer-badge ${settings.killSwitch ? "badge-danger" : ""}`}>
              {settings.killSwitch ? "Kill switch ON" : "Live"}
            </span>
          }
        />
        <div className="resolve-controls">
          <label>
            Daily spend cap
            <Input
              type="number"
              min="0"
              step="0.01"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              style={{ width: 120 }}
            />
          </label>
          <Button variant="secondary" size="compact" disabled={busy} onClick={saveCap}>
            Save cap
          </Button>
          <Button
            variant={settings.killSwitch ? "primary" : "danger"}
            size="compact"
            disabled={busy}
            onClick={toggleKillSwitch}
          >
            {settings.killSwitch ? "Turn kill switch off" : "Pause everything (kill switch)"}
          </Button>
        </div>
        <p className="section-reason">
          {money(committedCents)} of {money(capCents)} committed per day across{" "}
          {launches.filter(isSpending).length} live campaign(s).
        </p>
        <div className="budget-meter" aria-hidden>
          <div
            className="budget-meter-fill"
            style={{ width: `${meterPct}%`, background: meterPct >= 100 ? "#d23f57" : undefined }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="add" size="sm" />
              New launch
            </span>
          }
        />
        {connectedAccounts.length === 0 ? (
          <EmptyState description={<>No connected ad account.{" "}
            <Link href={`/workspaces/${id}/connectors`}>Connect Meta Ads</Link>, then{" "}
            <Link href={`/workspaces/${id}/ads`}>import your ad accounts</Link> first.</>} />
        ) : creatives.length === 0 ? (
          <EmptyState description={<>No approved Meta creative yet.{" "}
            <Link href={`/workspaces/${id}/ad-creatives`}>Generate and approve one</Link> to launch
            it.</>} />
        ) : (
          <>
            <div className="resolve-controls">
              <label>
                Ad account
                <Select
                  value={form.adAccountId || connectedAccounts[0]?.id}
                  onChange={(e) => setForm((f) => ({ ...f, adAccountId: e.target.value }))}
                >
                  {connectedAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Approved creative
                <Select
                  value={form.creativeDraftId}
                  onChange={(e) => setForm((f) => ({ ...f, creativeDraftId: e.target.value }))}
                >
                  <option value="">— pick a creative —</option>
                  {creatives.map((c) => (
                    <option key={c.draftId} value={c.draftId}>
                      {c.campaignName ? `[${c.campaignName}] ` : ""}
                      {c.headline} — {c.primaryText.slice(0, 40)}
                      {c.primaryText.length > 40 ? "…" : ""}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                Objective
                <Select
                  value={form.objective}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, objective: e.target.value as AdLaunchObjective }))
                  }
                >
                  {AD_LAUNCH_OBJECTIVES.map((o) => (
                    <option key={o} value={o}>
                      {AD_LAUNCH_OBJECTIVE_LABELS[o]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="resolve-controls">
              <label>
                Campaign name
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="June traffic push"
                />
              </label>
              <label>
                Facebook Page ID
                <Input
                  value={form.pageId}
                  onChange={(e) => setForm((f) => ({ ...f, pageId: e.target.value }))}
                  placeholder="123456789"
                />
              </label>
              <label>
                Destination URL
                <Input
                  value={form.linkUrl}
                  onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))}
                  placeholder="https://…"
                />
              </label>
            </div>
            <div className="resolve-controls">
              <label>
                Daily budget
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  value={form.dailyBudget}
                  onChange={(e) => setForm((f) => ({ ...f, dailyBudget: e.target.value }))}
                  style={{ width: 100 }}
                />
              </label>
              <label>
                Countries
                <Input
                  value={form.countries}
                  onChange={(e) => setForm((f) => ({ ...f, countries: e.target.value }))}
                  placeholder="US, DE"
                  style={{ width: 120 }}
                />
              </label>
              <label>
                Age min
                <Input
                  type="number"
                  min="18"
                  max="65"
                  value={form.ageMin}
                  onChange={(e) => setForm((f) => ({ ...f, ageMin: e.target.value }))}
                  style={{ width: 70 }}
                />
              </label>
              <label>
                Age max
                <Input
                  type="number"
                  min="18"
                  max="65"
                  value={form.ageMax}
                  onChange={(e) => setForm((f) => ({ ...f, ageMax: e.target.value }))}
                  style={{ width: 70 }}
                />
              </label>
            </div>
            <div className="editor-actions">
              <Button
                variant="primary"
                disabled={busy || !form.name.trim() || !form.creativeDraftId || !form.pageId.trim()}
                onClick={createLaunch}
              >
                Create draft launch
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="status-live" size="sm" />
              Launches{" "}
              {launches.length > 0 && <CountBadge count={launches.length} label="ad launches" />}
            </span>
          }
        />
        {launches.length === 0 ? (
          <EmptyState
            title="No launches yet"
            description="Build one above — it goes through the approval gate before any spend starts, and lands here with its live status and delivery metrics."
          />
        ) : (
          <ul className="section-list">
            {launches.map((launch) => {
              const currency = launch.account?.currency ?? "USD";
              const spending = isSpending(launch);
              const d = detail[launch.id];
              const submission = launchSubmissions[launch.id] ?? null;
              const campaignName = launch.campaignId
                ? (campaigns.find((campaign) => campaign.id === launch.campaignId)?.name ?? "Unknown campaign")
                : "No linked campaign";
              return (
                <li key={launch.id} className="section-card">
                  <div className="section-head">
                    <span className="section-title">{launch.name}</span>
                    <span className="layer-badge">{STATUS_LABELS[launch.status]}</span>
                    {launch.status === "launched" && (
                      <span className={`layer-badge ${spending ? "badge-active" : ""}`}>
                        {launch.platformStatus ?? "ACTIVE"}
                      </span>
                    )}
                    <span className="meta" style={{ marginLeft: "auto" }}>
                      {money(launch.dailyBudgetCents, currency)}/day · {launch.account?.name ?? "—"}
                    </span>
                  </div>
                  <p className="section-reason">
                    {AD_LAUNCH_OBJECTIVE_LABELS[launch.objective]} ·{" "}
                    {launch.creative
                      ? `"${launch.creative.headline}" — ${launch.creative.primaryText}`
                      : "creative unavailable"}
                  </p>
                  {launch.lastError && <p className="error-inline">{launch.lastError}</p>}
                  {submission ? (
                    <div className={styles.actionStatus}>
                      <WorkflowStatusBadge
                        status={externalActionWorkflowStatus(submission.action)}
                      />
                      <span>{submissionNote(submission)}</span>
                      <Link href={actionAuthorizationHref(submission.action)}>View action</Link>
                    </div>
                  ) : launch.externalActionId ? (
                    <p className={styles.actionStatus}>
                      <Link
                        href={reviewHref(id, {
                          tab: "authorizations",
                          action: launch.externalActionId,
                        })}
                      >
                        View governing action
                      </Link>
                    </p>
                  ) : null}

                  <div className="editor-actions">
                    {launch.status === "draft" && (
                      <>
                        <Button variant="primary" disabled={busy} onClick={() => act(launch, "submit")}>
                          Submit for approval
                        </Button>
                        <Button
                          variant="danger"
                          size="compact"
                          disabled={busy}
                          onClick={() => remove(launch)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                    {launch.status === "pending_review" && (
                      <>
                        <Button variant="primary" disabled={busy} onClick={() => act(launch, "approve")}>
                          Approve spend
                        </Button>
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => act(launch, "reject")}
                        >
                          Reject
                        </Button>
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => act(launch, "revise")}
                        >
                          Back to draft
                        </Button>
                      </>
                    )}
                    {launch.status === "approved" && (
                      <>
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() =>
                            act(
                              launch,
                              "launch",
                              `Launch "${launch.name}" and start spending ${money(launch.dailyBudgetCents, currency)}/day?`,
                            )
                          }
                        >
                          {launch.lastError ? "Retry launch" : "Launch"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => act(launch, "revise")}
                        >
                          Back to draft
                        </Button>
                      </>
                    )}
                    {launch.status === "rejected" && (
                      <Button variant="primary" disabled={busy} onClick={() => act(launch, "revise")}>
                        Back to draft
                      </Button>
                    )}
                    {launch.status === "launched" &&
                      (spending ? (
                        <Button
                          variant="secondary"
                          size="compact"
                          disabled={busy}
                          onClick={() => act(launch, "pause")}
                        >
                          Pause
                        </Button>
                      ) : (
                        <Button variant="primary" disabled={busy} onClick={() => act(launch, "resume")}>
                          Resume
                        </Button>
                      ))}
                    {launch.status === "launched" && (
                      <>
                        <Button
                          variant="secondary"
                          leadingIcon={<Icon name="budget" />}
                          disabled={busy}
                          onClick={() => void openMutation(launch, "budget")}
                        >
                          Change budget
                        </Button>
                        <Button
                          variant="secondary"
                          leadingIcon={<Icon name="targeting" />}
                          disabled={busy}
                          onClick={() => void openMutation(launch, "targeting")}
                        >
                          Change targeting
                        </Button>
                      </>
                    )}
                    <Button variant="tertiary" size="compact" onClick={() => toggleDetail(launch.id)}>
                      {d ? "Hide log" : "Decision log"}
                    </Button>
                  </div>

                  {mutation?.launchId === launch.id && (() => {
                    const requestedBudgetCents = Math.round(Number(mutation.budgetInput) * 100);
                    const budgetDiff = budgetChangeDiff(
                      mutation.beforeDailyBudgetCents,
                      requestedBudgetCents,
                    );
                    const requestedTargeting = {
                      countries: mutation.countriesInput
                        .split(",")
                        .map((country) => country.trim().toUpperCase())
                        .filter(Boolean),
                      ageMin: Number(mutation.ageMinInput),
                      ageMax: Number(mutation.ageMaxInput),
                    };
                    const targetingDiff = targetingChangeDiff(
                      mutation.provider,
                      requestedTargeting,
                    );
                    const submission = mutation.submission;
                    const recovery =
                      submission && ["blocked", "stale", "failed"].includes(submission.action.status);
                    return (
                      <section className={styles.mutationPanel} aria-label={`Change ${mutation.kind}`}>
                        <div className={styles.mutationHeading}>
                          <div>
                            <h4>{mutation.kind === "budget" ? "Change budget" : "Change targeting"}</h4>
                            <p>
                              {launch.account?.name ?? "Meta account"} · {campaignName} · {launch.name} ·{" "}
                              {mutation.provider.externalAdSetId}
                            </p>
                          </div>
                          <Button variant="tertiary" size="compact" onClick={() => setMutation(null)}>
                            Close
                          </Button>
                        </div>

                        {mutation.kind === "budget" ? (
                          <>
                            <div className={styles.formGrid}>
                              <div className={styles.readValue}>
                                <span>Current provider budget</span>
                                <strong>{money(mutation.beforeDailyBudgetCents, currency)}/day</strong>
                              </div>
                              <label>
                                Requested daily budget ({currency})
                                <Input
                                  type="number"
                                  min="1"
                                  step="0.01"
                                  value={mutation.budgetInput}
                                  onChange={(event) => editMutation({ budgetInput: event.target.value })}
                                />
                              </label>
                            </div>
                            {Number.isFinite(requestedBudgetCents) && (
                              <p className={styles.diffSummary}>
                                {budgetDiff.deltaCents >= 0 ? "Increase" : "Decrease"} by{" "}
                                {money(budgetDiff.absoluteDeltaCents, currency)}
                                {budgetDiff.percentDelta === null
                                  ? ""
                                  : ` (${budgetDiff.percentDelta >= 0 ? "+" : ""}${budgetDiff.percentDelta.toFixed(1)}%)`}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <div className={styles.formGrid}>
                              <label>
                                Countries
                                <Input
                                  value={mutation.countriesInput}
                                  onChange={(event) => editMutation({ countriesInput: event.target.value })}
                                  placeholder="US, DE"
                                />
                              </label>
                              <label>
                                Minimum age
                                <Input
                                  type="number"
                                  min="18"
                                  max="65"
                                  value={mutation.ageMinInput}
                                  onChange={(event) => editMutation({ ageMinInput: event.target.value })}
                                />
                              </label>
                              <label>
                                Maximum age
                                <Input
                                  type="number"
                                  min="18"
                                  max="65"
                                  value={mutation.ageMaxInput}
                                  onChange={(event) => editMutation({ ageMaxInput: event.target.value })}
                                />
                              </label>
                            </div>
                            <div className={styles.diffGrid}>
                              <p><strong>Countries added</strong><span>{targetingDiff.countriesAdded.join(", ") || "None"}</span></p>
                              <p><strong>Countries removed</strong><span>{targetingDiff.countriesRemoved.join(", ") || "None"}</span></p>
                              <p><strong>Age range</strong><span>{targetingDiff.beforeAge.min}–{targetingDiff.beforeAge.max} → {targetingDiff.afterAge.min}–{targetingDiff.afterAge.max}</span></p>
                            </div>
                          </>
                        )}

                        <p className={styles.guardrailNote}>
                          Workspace kill switch, daily cap, account connection, and Meta limits are
                          rechecked before this change executes.
                        </p>

                        {submission && (
                          <div className={styles.mutationOutcome}>
                            <div className={styles.badgeRow}>
                              <WorkflowStatusBadge status={externalActionWorkflowStatus(submission.action)} />
                              <WorkflowStatusBadge
                                status={effectivePolicyWorkflowStatus(submission.action.policy.effective)}
                              />
                            </div>
                            <p>{submissionNote(submission)}</p>
                            <p>{policyExplanation(submission.action)}</p>
                            {submission.action.blocker && <p className="error-inline">{submission.action.blocker.message}</p>}
                            {submission.execution && (
                              <p className={styles.receipt}>
                                Provider receipt: {submission.execution.kind} · {submission.execution.status}
                                {submission.execution.error ? ` · ${submission.execution.error}` : ""}
                              </p>
                            )}
                            <ButtonLink
                              variant={recovery ? "secondary" : "primary"}
                              href={externalActionHref(submission.action)}
                              leadingIcon={<Icon name={recovery ? "regenerate" : "authorize"} />}
                              onClick={(event) => {
                                if (!recovery) return;
                                event.preventDefault();
                                void openMutation(launch, mutation.kind, true);
                              }}
                            >
                              {recovery
                                ? "Refresh provider state"
                                : submission.action.status === "authorization_required"
                                  ? "Open authorization"
                                  : "View action"}
                            </ButtonLink>
                          </div>
                        )}

                        <div className={styles.mutationActions}>
                          <Button
                            variant="primary"
                            loading={busy}
                            onClick={() => void proposeMutation()}
                            disabled={
                              mutation.kind === "budget"
                                ? !Number.isFinite(requestedBudgetCents) || requestedBudgetCents < 100 || budgetDiff.deltaCents === 0
                                : requestedTargeting.countries.length === 0 ||
                                  requestedTargeting.ageMin < 18 ||
                                  requestedTargeting.ageMax > 65 ||
                                  requestedTargeting.ageMin > requestedTargeting.ageMax
                            }
                          >
                            Propose {mutation.kind} change
                          </Button>
                          <span>Authorization decisions happen in Review, never inline.</span>
                        </div>
                      </section>
                    );
                  })()}

                  {d && (
                    <ul className="draft-chain">
                      {d.decisions.length === 0 ? (
                        <li className="meta">No decisions yet.</li>
                      ) : (
                        d.decisions.map((decision) => (
                          <li key={decision.id}>
                            <span className="meta">{new Date(decision.createdAt).toLocaleString()}</span>{" "}
                            — <strong>{decision.action}</strong> by {decision.actor} (
                            {decision.fromState} → {decision.toState})
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
