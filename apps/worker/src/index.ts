import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkerClient,
  type WorkerClient,
} from "./client";
import {
  loadRootEnv,
  parseWorkerConfig,
  type WorkerConfig,
} from "./config";
import {
  startSettledLoop,
  type SettledLoop,
} from "./scheduler";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface StartWorkerInput {
  config: WorkerConfig;
  client: WorkerClient;
  startLoop?: typeof startSettledLoop;
  logger?: WorkerLogger;
}

export function startWorker({
  config,
  client,
  startLoop = startSettledLoop,
  logger = {
    info: (message) => console.info(message),
    error: (message) => console.error(message),
  },
}: StartWorkerInput): SettledLoop {
  logger.info(
    JSON.stringify({
      event: "background_jobs_worker_started",
      internalApiUrl: config.internalApiUrl,
      pollMs: config.queuePollMs,
    }),
  );
  return startLoop({
    name: "background-jobs",
    intervalMs: config.queuePollMs,
    async run() {
      const result = await client.runBackgroundJobsTick();
      logger.info(JSON.stringify({ event: "background_jobs_tick", ...result }));
    },
    onError(error) {
      logger.error(
        JSON.stringify({
          event: "background_jobs_tick_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
}

function main(): void {
  loadRootEnv();
  const config = parseWorkerConfig(process.env);
  const loop = startWorker({ config, client: createWorkerClient(config) });
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    loop.stop();
    console.info(
      JSON.stringify({ event: "background_jobs_worker_stopped", signal }),
    );
    process.exitCode = 0;
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) main();
