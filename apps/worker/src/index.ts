// Tuezday worker. First job: poll signal discovery for every workspace on an
// interval. The API owns all DB access — the worker only calls HTTP endpoints.

const API_URL = process.env.TUEZDAY_API_URL ?? "http://localhost:3001";
const INTERVAL_MIN = Number(process.env.DISCOVERY_INTERVAL_MIN ?? 30);

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

async function tick(): Promise<void> {
  try {
    await runDiscoveryForAllWorkspaces();
  } catch (err) {
    console.error("[discovery] tick failed —", err instanceof Error ? err.message : err);
  }
}

console.log(
  `Tuezday worker: polling discovery every ${INTERVAL_MIN} min against ${API_URL} (set DISCOVERY_INTERVAL_MIN / TUEZDAY_API_URL to change).`,
);
void tick();
setInterval(() => void tick(), INTERVAL_MIN * 60 * 1000);
