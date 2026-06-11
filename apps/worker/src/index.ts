// Tuezday worker. First job: poll signal discovery for every workspace on an
// interval. The API owns all DB access — the worker only calls HTTP endpoints.

const API_URL = process.env.TUEZDAY_API_URL ?? "http://localhost:3001";
const INTERVAL_MIN = Number(process.env.DISCOVERY_INTERVAL_MIN ?? 30);
const SYNTHESIS_DAYS = Number(process.env.LEARNING_SYNTHESIS_DAYS ?? 7);

interface Workspace {
  id: string;
  name: string;
}

interface RunResult {
  sources: Array<{ name: string; fetched: number; new: number; error?: string }>;
  scored: number;
}

async function runDiscoveryForAllWorkspaces(): Promise<void> {
  const res = await fetch(`${API_URL}/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const runRes = await fetch(`${API_URL}/workspaces/${workspace.id}/discovery/run`, {
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
  const res = await fetch(`${API_URL}/workspaces`);
  if (!res.ok) throw new Error(`GET /workspaces returned ${res.status}`);
  const workspaces = (await res.json()) as Workspace[];

  for (const workspace of workspaces) {
    try {
      const list = (await (
        await fetch(`${API_URL}/workspaces/${workspace.id}/learning/syntheses`)
      ).json()) as Synthesis[];
      const hasOpenProposal = list.some((s) => s.status === "proposed");
      const newest = list[0]?.createdAt ?? 0;
      const due = Date.now() - newest > SYNTHESIS_DAYS * 24 * 60 * 60 * 1000;
      if (hasOpenProposal || !due) continue;

      const synth = await fetch(`${API_URL}/workspaces/${workspace.id}/learning/synthesize`, {
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
  `Tuezday worker: polling discovery every ${INTERVAL_MIN} min against ${API_URL} (set DISCOVERY_INTERVAL_MIN / TUEZDAY_API_URL to change).`,
);
void tick();
setInterval(() => void tick(), INTERVAL_MIN * 60 * 1000);
