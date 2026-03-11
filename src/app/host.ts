import { startCli, type RunCliOptions } from "./cli.js";

export interface HostSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export async function runHost(
  argv: string[],
  options: RunCliOptions & {
    signals?: HostSignalSource;
  },
): Promise<number> {
  const started = await startCli(argv, options);
  if (started.exitCode !== 0 || !started.service) {
    return started.exitCode;
  }

  const signals = options.signals ?? process;
  const stderr =
    options.stderr ??
    ((message: string) => process.stderr.write(`${message}\n`));

  return new Promise<number>((resolve) => {
    let stopping = false;

    const cleanup = () => {
      signals.off("SIGINT", handleSigint);
      signals.off("SIGTERM", handleSigterm);
    };

    const stopService = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      cleanup();
      try {
        await started.service?.stop();
        resolve(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(`shutdown_failed ${message}`);
        resolve(1);
      }
    };

    const handleSigint = () => {
      void stopService();
    };

    const handleSigterm = () => {
      void stopService();
    };

    signals.on("SIGINT", handleSigint);
    signals.on("SIGTERM", handleSigterm);
  });
}
