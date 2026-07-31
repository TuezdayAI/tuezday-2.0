export interface SettledLoop {
  stop(): void;
}

export function startSettledLoop(input: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}): SettledLoop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const execute = async () => {
    try {
      await input.run();
    } catch (error) {
      input.onError(error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void execute();
        }, input.intervalMs);
      }
    }
  };

  void execute();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
