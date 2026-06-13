// Tuezday worker. First job: poll signal discovery for every workspace on an
// interval. The API owns all DB access — the worker only calls HTTP endpoints.

const API_URL = process.env.TUEZDAY_API_URL ?? "http://localhost:3001";
// Shared secret that authenticates the worker as the API's `system` actor
// (Sprint 19). Must match TUEZDAY_WORKER_TOKEN on the API process.
const WORKER_TOKEN = process.env.TUEZDAY_WORKER_TOKEN ?? "";

function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (WORKER_TOKEN) headers.set("Authorization", `Bearer ${WORKER_TOKEN}`);
  return fetch(`${API_URL}${path}`, { ...init, headers });
}
const INTERVAL_MIN = Number(process.env.DISCOVERY_INTERVAL_MIN ?? 30);
const SYNTHESIS_DAYS = Number(process.env.LEARNING_SYNTHESIS_DAYS ?? 7);
const ADS_SYNC_HOURS = Number(process.env.ADS_SYNC_HOURS ?? 6);
const PUBLISH_INTERVAL_MIN = Number(process.env.PUBLISH_INTERVAL_MIN ?? 1);

interface Workspace {
  id: string;
  name: string;
}

interface RunResult {
  sources: Array<{ name: string; fetched: number; new: number; error?: string }>;
  scored: number;
}

async function runDiscoveryForAllWorkspaces(): Promise<void> {
  const res = await api(`/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await api(`/workspaces/${workspace.id}/discovery/run`, {
        method: "POST",
      });
      if (!runRes.ok) throw new Error(`run returned ${runRes.status}`);
      const result = (await runRes.json()) as RunResult;
      const totals = result.sources.reduce(
        (acc, s) => ({ fetched: acc.fetched + s.fetched, fresh: acc.fresh + s.new }),
        { fetched: 0, fresh: 0 },
      );
      const errors = result.sources.filter((s) => s.error).length;
      console.log(
        `[discovery] ${workspace.name}: ${result.sources.length} sources, ${totals.fetched} fetched, ${totals.fresh} new, ${result.scored} scored${errors ? `, ${errors} source error(s)` : ""}`,
      );
    } catch (err) {
      console.error(
        `[discovery] ${workspace.name}: failed —`,
        err instanceof Error ? err.message : err,
      );
    }
  }
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
      const due = Date.now() - newest > SYNTHESIS_DAYS * 24 * 60 * 60 * 1000;
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

async function publishTick(): Promise<void> {
  try {
    await runDuePublicationsForAllWorkspaces();
  } catch (err) {
    console.error("[publish] tick failed —", err instanceof Error ? err.message : err);
  }
}

async function adsTick(): Promise<void> {
  try {
    await syncAdsForAllWorkspaces();
  } catch (err) {
    console.error("[ads] tick failed —", err instanceof Error ? err.message : err);
  }
}

async function tick(): Promise<void> {
  try {
    await runDiscoveryForAllWorkspaces();
  } catch (err) {
    console.error("[discovery] tick failed —", err instanceof Error ? err.message : err);
  }
  try {
    await maybeSynthesizeForAllWorkspaces();
  } catch (err) {
    console.error("[learning] tick failed —", err instanceof Error ? err.message : err);
  }
}

console.log(
  `Tuezday worker: polling discovery every ${INTERVAL_MIN} min, ads sync every ${ADS_SYNC_HOURS} h, scheduled publishing every ${PUBLISH_INTERVAL_MIN} min against ${API_URL} (set DISCOVERY_INTERVAL_MIN / ADS_SYNC_HOURS / PUBLISH_INTERVAL_MIN / TUEZDAY_API_URL to change).`,
);
void tick();
setInterval(() => void tick(), INTERVAL_MIN * 60 * 1000);
void adsTick();
setInterval(() => void adsTick(), ADS_SYNC_HOURS * 60 * 60 * 1000);
void publishTick();
setInterval(() => void publishTick(), PUBLISH_INTERVAL_MIN * 60 * 1000);
