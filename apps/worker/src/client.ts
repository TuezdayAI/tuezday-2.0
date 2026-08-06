import type { WorkerConfig } from "./config";

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface CadenceRunIssue {
  code: "nonexistent_local_time" | "publish_validation";
  cadenceId: string;
  draftId: string | null;
  slot: number | null;
  message: string;
}

export interface CadenceRunResult {
  cadenceId: string;
  filled: number;
  issues: CadenceRunIssue[];
}

export function summarizeCadenceRun(
  results: CadenceRunResult[],
): { filled: number; issues: CadenceRunIssue[] } {
  return {
    filled: results.reduce((sum, result) => sum + result.filled, 0),
    issues: results.flatMap((result) => result.issues),
  };
}

export type PublishOutcomeState = "published" | "processing" | "blocked" | "failed";

export interface PublishOutcome {
  id: string;
  state: PublishOutcomeState;
  error?: string;
}

export interface PublishingRun {
  actions: Array<{
    action: {
      id: string;
      kind: string;
      status: string;
      blocker?: { code?: string; message?: string } | null;
    };
    execution?: { id: string; status: string; error?: string | null } | null;
  }>;
  results: Array<{ id: string; state: PublishOutcomeState; ok: boolean; error?: string }>;
}

export function summarizePublishRun(run: PublishingRun): {
  published: number;
  processing: number;
  blocked: number;
  failed: number;
  outcomes: PublishOutcome[];
} {
  const governed: PublishOutcome[] = run.actions
    .filter(({ action }) => action.kind === "publish")
    .map(({ action, execution }) => {
      const id = execution?.id ?? action.id;
      if (action.status === "succeeded") return { id, state: "published" };
      if (action.status === "blocked") {
        return {
          id,
          state: "blocked",
          ...(action.blocker?.code ? { error: action.blocker.code } : {}),
        };
      }
      if (action.status === "failed") {
        return {
          id,
          state: "failed",
          ...(execution?.error ? { error: execution.error } : {}),
        };
      }
      return { id, state: "processing" };
    });
  const outcomes: PublishOutcome[] = [
    ...governed,
    ...run.results.map(({ id, state, error }) => ({
      id,
      state,
      ...(error ? { error } : {}),
    })),
  ];
  return {
    published: outcomes.filter((outcome) => outcome.state === "published").length,
    processing: outcomes.filter((outcome) => outcome.state === "processing").length,
    blocked: outcomes.filter((outcome) => outcome.state === "blocked").length,
    failed: outcomes.filter((outcome) => outcome.state === "failed").length,
    outcomes,
  };
}

export interface WorkerClient {
  request(path: string, init?: RequestInit): Promise<Response>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  runInternal(
    path:
      | "/internal/discovery/tick"
      | "/internal/automation/tick"
      | "/internal/pipelines/tick"
      | "/internal/preferences/tick",
  ): Promise<unknown>;
  runPublishing(workspaceId: string): Promise<PublishingRun>;
}

export interface WorkerClientOptions {
  fetcher?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export function createWorkerClient(
  config: WorkerConfig,
  options: WorkerClientOptions = {},
): WorkerClient {
  const fetcher = options.fetcher ?? fetch;
  const maxAttempts = options.maxAttempts ?? 20;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${config.token}`);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fetcher(`${config.internalApiUrl}${path}`, {
          ...init,
          headers,
        });
      } catch (error) {
        if (
          attempt === maxAttempts ||
          init?.signal?.aborted
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryDelayMs);
        });
      }
    }
    throw new Error("worker_request_attempts_exhausted");
  };

  return {
    request,
    async listWorkspaces() {
      const response = await request("/workspaces");
      if (!response.ok) {
        throw new Error(`GET /workspaces returned ${response.status}`);
      }
      return (await response.json()) as WorkspaceSummary[];
    },
    async runInternal(path) {
      const response = await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        throw new Error(`POST ${path} returned ${response.status}`);
      }
      return response.json();
    },
    async runPublishing(workspaceId) {
      const actionResponse = await request(
        `/workspaces/${workspaceId}/external-actions/run`,
        { method: "POST" },
      );
      if (!actionResponse.ok) {
        throw new Error(`external-action run returned ${actionResponse.status}`);
      }
      const { actions } = (await actionResponse.json()) as Pick<PublishingRun, "actions">;

      const publicationResponse = await request(`/workspaces/${workspaceId}/publish/run`, {
        method: "POST",
      });
      if (!publicationResponse.ok) {
        throw new Error(`publish run returned ${publicationResponse.status}`);
      }
      const { results } = (await publicationResponse.json()) as Pick<PublishingRun, "results">;
      return { actions, results };
    },
  };
}
