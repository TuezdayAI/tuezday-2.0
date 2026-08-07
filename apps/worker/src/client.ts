import type { WorkerConfig } from "./config";

export interface BackgroundJobsTickResult {
  busy: boolean;
  reconciled: number;
  admitted: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  lost: number;
}

export interface WorkerClient {
  runBackgroundJobsTick(): Promise<BackgroundJobsTickResult>;
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

  return {
    async runBackgroundJobsTick() {
      const path = "/internal/background-jobs/tick";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetcher(`${config.internalApiUrl}${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.token}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          if (!response.ok) {
            throw new Error(`POST ${path} returned ${response.status}`);
          }
          return (await response.json()) as BackgroundJobsTickResult;
        } catch (error) {
          const isHttpError =
            error instanceof Error &&
            error.message.startsWith(`POST ${path} returned `);
          if (isHttpError || attempt === maxAttempts) throw error;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, retryDelayMs);
          });
        }
      }
      throw new Error("worker_request_attempts_exhausted");
    },
  };
}
