import { resolve } from "node:path";

export interface CliService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RunCliOptions {
  cwd: string;
  createService: (input: { workflowPath: string }) => Promise<CliService>;
  stderr?: (message: string) => void;
}

export async function runCli(argv: string[], options: RunCliOptions): Promise<number> {
  const workflowPath = argv[0] ? resolve(argv[0]) : resolve(options.cwd, "WORKFLOW.md");
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));

  try {
    const service = await options.createService({ workflowPath });
    await service.start();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`startup_failed ${message}`);
    return 1;
  }
}
