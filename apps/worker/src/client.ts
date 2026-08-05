import type { WorkerConfig } from "./config";

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface WorkerClient {
  request(path: string, init?: RequestInit): Promise<Response>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  runInternal(
    path:
      | "/internal/discovery/tick"
      | "/internal/automation/tick"
      | "/internal/pipelines/tick",
  ): Promise<unknown>;
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
  };
}
