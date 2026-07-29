import { createWorkerClient } from "./client";
import { loadRootEnv, parseWorkerConfig } from "./config";
import { startSettledLoop } from "./scheduler";

loadRootEnv();
const config = parseWorkerConfig(process.env);
const worker = createWorkerClient(config);

function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.request(path, init);
}

interface Workspace {
  id: string;
  name: string;
}

async function runDiscoveryForAllWorkspaces(): Promise<void> {
  const result = (await worker.runInternal(
    "/internal/discovery/tick",
  )) as { busy?: boolean; processed?: number };
  console.log(
    `[discovery] ${result.busy ? "busy" : `${result.processed ?? 0} source job(s) processed`}`,
  );
}

interface Synthesis {
  status: string;
  createdAt: number;
}

/** The plan's "weekly now synthesis": propose when there is no open proposal
 * and the newest synthesis is older than SYNTHESIS_DAYS. The founder still
 * reviews every proposal before it touches the brain. */
async function maybeSynthesizeForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const list = (await (
        await api(`/workspaces/${workspace.id}/learning/syntheses`)
      ).json()) as Synthesis[];
      const hasOpenProposal = list.some((s) => s.status === "proposed");
      const newest = list[0]?.createdAt ?? 0;
      const due = Date.now() - newest > config.intervals.learningMs;
      if (hasOpenProposal || !due) continue;

      const synth = await api(`/workspaces/${workspace.id}/learning/synthesize`, {
        method: "POST",
      });
      if (synth.status === 201) {
        console.log(`[learning] ${workspace.name}: weekly synthesis proposed for review`);
      } else if (synth.status !== 409) {
        // 409 = nothing to learn yet; anything else is worth logging
        console.error(`[learning] ${workspace.name}: synthesize returned ${synth.status}`);
      }
    } catch (err) {
      console.error(
        `[learning] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

interface AdsSyncResponse {
  results: Array<{
    name: string;
    ok: boolean;
    error?: string;
    rows?: number;
    created?: number;
    updated?: number;
  }>;
}

/** Re-pull the recent metric window for every connected ad account. Meta
 * restates conversions retroactively, so re-syncing keeps numbers converging. */
async function syncAdsForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const syncRes = await api(`/workspaces/${workspace.id}/ads/sync`, {
        method: "POST",
      });
      if (!syncRes.ok) throw new Error(`sync returned ${syncRes.status}`);
      const { results } = (await syncRes.json()) as AdsSyncResponse;
      if (results.length === 0) continue; // nothing connected — stay quiet
      for (const result of results) {
        if (result.ok) {
          console.log(
            `[ads] ${workspace.name} / ${result.name}: ${result.rows ?? 0} rows (${result.created ?? 0} new, ${result.updated ?? 0} updated)`,
          );
        } else {
          console.error(`[ads] ${workspace.name} / ${result.name}: failed — ${result.error}`);
        }
      }
    } catch (err) {
      console.error(
        `[ads] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

interface PublishRunResponse {
  results: Array<{ id: string; ok: boolean; error?: string }>;
}

/** Fire scheduled social posts that have come due. */
async function runDuePublicationsForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/publish/run`, {
        method: "POST",
      });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { results } = (await runRes.json()) as PublishRunResponse;
      if (results.length === 0) continue; // nothing due — stay quiet
      const published = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      console.log(`[publish] ${workspace.name}: ${published} published, ${failed.length} failed`);
      for (const failure of failed) {
        console.error(`[publish] ${workspace.name} / ${failure.id}: ${failure.error}`);
      }
    } catch (err) {
      console.error(
        `[publish] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

interface CadenceRunResponse {
  results: Array<{ cadenceId: string; filled: number }>;
}

/** Top up every active cadence's queue: approved drafts → scheduled posts. The
 * publish tick then fires those when their slot comes due. */
async function fillCadencesForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/cadences/run`, { method: "POST" });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { results } = (await runRes.json()) as CadenceRunResponse;
      const filled = results.reduce((sum, r) => sum + r.filled, 0);
      if (filled === 0) continue; // nothing to slot — stay quiet
      console.log(`[cadence] ${workspace.name}: ${filled} draft(s) slotted across ${results.length} cadence(s)`);
    } catch (err) {
      console.error(
        `[cadence] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Turn new discovery signals into channel drafts per each campaign's automation
 * mode: human_in_the_loop queues at the gate, scheduled_auto auto-approves so the
 * cadence tick can post them. */
async function runAutomationForAllWorkspaces(): Promise<void> {
  const result = (await worker.runInternal(
    "/internal/automation/tick",
  )) as { busy?: boolean; processed?: number };
  console.log(
    `[automation] ${result.busy ? "busy" : `${result.processed ?? 0} workspace(s) processed`}`,
  );
}

interface InboxRunResponse {
  newItems: number;
  metricsCaptured: number;
  repliesPosted: number;
}

interface MailboxInboxRunResponse {
  mailboxesPolled: number;
  newItems: number;
  labeled: number;
}

interface OutreachRunResponse {
  enrolled: number;
  generated: number;
  dispatched: number;
  stopped: number;
  completed: number;
}

/** Poll inbound comments/DMs, refresh engagement metrics, then auto-generate +
 * post replies for scheduled_auto campaigns (when the master switch is on). */
async function runInboxForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/inbox/run`, { method: "POST" });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { newItems, metricsCaptured, repliesPosted } = (await runRes.json()) as InboxRunResponse;
      if (newItems === 0 && metricsCaptured === 0 && repliesPosted === 0) continue; // quiet
      console.log(
        `[inbox] ${workspace.name}: ${newItems} new item(s), ${metricsCaptured} metric(s) captured, ${repliesPosted} repl(y/ies) posted`,
      );
    } catch (err) {
      console.error("[inbox] ", workspace.name, "failed —", err instanceof Error ? err.message : err);
    }
  }
}

// Poll connected Gmail mailboxes for inbound replies to threads we started,
// then classify them. The scheduler runs this before outreach so a reply found
// in this cycle can stop the enrollment before its next step generates.
async function runMailboxInboxForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(
        `/workspaces/${workspace.id}/mailbox-inbox/run`,
        { method: "POST" },
      );
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { mailboxesPolled, newItems, labeled } =
        (await runRes.json()) as MailboxInboxRunResponse;
      if (mailboxesPolled === 0 || (newItems === 0 && labeled === 0)) {
        continue;
      }
      console.log(
        `[mailbox-inbox] ${workspace.name}: ${newItems} new repl(y/ies), ${labeled} labeled`,
      );
    } catch (err) {
      console.error(
        `[mailbox-inbox] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// Auto-enroll live-segment matches and advance active outreach enrollments
// through generate, approval, and mailbox delivery.
async function runOutreachForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/outreach/run`, {
        method: "POST",
      });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { enrolled, dispatched, stopped, completed } =
        (await runRes.json()) as OutreachRunResponse;
      if (
        enrolled === 0 &&
        dispatched === 0 &&
        stopped === 0 &&
        completed === 0
      ) {
        continue;
      }
      console.log(
        `[outreach] ${workspace.name}: ${enrolled} enrolled, ${dispatched} sent, ${stopped} stopped, ${completed} completed`,
      );
    } catch (err) {
      console.error(
        `[outreach] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

interface SequenceRunResponse {
  generated: number;
  sent: number;
  stopped: number;
  completed: number;
}

/** Advance every launch's multi-step sequence: generate due steps, auto-send X
 * DMs (scheduled_auto), stop X chains on reply. Runs after inbox so a reply
 * detected this cycle stops the chain before the next step generates. */
async function runSequencesForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/sequences/run`, { method: "POST" });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const { generated, sent, stopped, completed } = (await runRes.json()) as SequenceRunResponse;
      if (generated === 0 && sent === 0 && stopped === 0 && completed === 0) continue; // quiet
      console.log(
        `[sequences] ${workspace.name}: ${generated} generated, ${sent} sent, ${stopped} stopped, ${completed} completed`,
      );
    } catch (err) {
      console.error("[sequences] ", workspace.name, "failed —", err instanceof Error ? err.message : err);
    }
  }
}

/** Propose each workspace's signals + published posts as ingest candidates.
 * Founder-gated: the sweep only queues candidates; nothing enters the corpus
 * until the founder accepts them. */
async function sweepEvidenceForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const sweepRes = await api(`/workspaces/${workspace.id}/evidence/candidates/sweep`, {
        method: "POST",
      });
      if (!sweepRes.ok) throw new Error(`sweep returned ${sweepRes.status}`);
      const { signal, published } = (await sweepRes.json()) as {
        signal: { proposed: number };
        published: { proposed: number };
      };
      const total = signal.proposed + published.proposed;
      if (total > 0) {
        console.log(
          `[evidence] ${workspace.name}: ${total} new candidate(s) (${signal.proposed} signal, ${published.proposed} published)`,
        );
      }
    } catch (err) {
      console.error(
        `[evidence] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

console.log(
  `Tuezday worker: validated task intervals against ${config.internalApiUrl}`,
);

const loopSpecs = [
  {
    name: "discovery",
    intervalMs: config.intervals.discoveryMs,
    run: runDiscoveryForAllWorkspaces,
  },
  {
    name: "automation",
    intervalMs: config.intervals.automationMs,
    run: runAutomationForAllWorkspaces,
  },
  {
    name: "learning",
    intervalMs: config.intervals.learningMs,
    run: maybeSynthesizeForAllWorkspaces,
  },
  {
    name: "ads",
    intervalMs: config.intervals.adsMs,
    run: syncAdsForAllWorkspaces,
  },
  {
    name: "cadence",
    intervalMs: config.intervals.cadenceMs,
    run: fillCadencesForAllWorkspaces,
  },
  {
    name: "publish",
    intervalMs: config.intervals.publishMs,
    run: runDuePublicationsForAllWorkspaces,
  },
  {
    name: "inbox",
    intervalMs: config.intervals.inboxMs,
    run: runInboxForAllWorkspaces,
  },
  {
    name: "mailbox-inbox",
    intervalMs: config.intervals.mailboxInboxMs,
    run: runMailboxInboxForAllWorkspaces,
  },
  {
    name: "outreach",
    intervalMs: config.intervals.outreachMs,
    run: runOutreachForAllWorkspaces,
  },
  {
    name: "sequence",
    intervalMs: config.intervals.sequenceMs,
    run: runSequencesForAllWorkspaces,
  },
  {
    name: "evidence",
    intervalMs: config.intervals.evidenceMs,
    run: sweepEvidenceForAllWorkspaces,
  },
] as const;

const loops = loopSpecs.map((spec) =>
  startSettledLoop({
    ...spec,
    onError(error) {
      console.error(
        `[${spec.name}] tick failed —`,
        error instanceof Error ? error.message : error,
      );
    },
  }),
);

let stopping = false;
function stopWorker(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const loop of loops) loop.stop();
  console.log(`Tuezday worker: stopped after ${signal}`);
  process.exitCode = 0;
}

process.once("SIGINT", () => stopWorker("SIGINT"));
process.once("SIGTERM", () => stopWorker("SIGTERM"));
