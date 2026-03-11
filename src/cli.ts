import { resolve } from "node:path";

export interface CliService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RunCliOptions {
  cwd: string;
  createService: (input: { workflowPath: string; port?: number }) => Promise<CliService>;
  stderr?: (message: string) => void;
}

export async function runCli(argv: string[], options: RunCliOptions): Promise<number> {
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const parsed = parseCliArgs(argv, options.cwd);
  if (!parsed.ok) {
    stderr(parsed.error);
    return 1;
  }

  try {
    const service = await options.createService(
      parsed.port == null
        ? { workflowPath: parsed.workflowPath }
        : { workflowPath: parsed.workflowPath, port: parsed.port }
    );
    await service.start();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`startup_failed ${message}`);
    return 1;
  }
}

function parseCliArgs(
  argv: string[],
  cwd: string
): { ok: true; workflowPath: string; port?: number } | { ok: false; error: string } {
  let port: number | undefined;
  let workflowPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        return { ok: false, error: "invalid --port: missing value" };
      }
      const parsedPort = parsePort(value);
      if (parsedPort == null) {
        return { ok: false, error: "invalid --port: expected integer" };
      }
      port = parsedPort;
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      const parsedPort = parsePort(arg.slice("--port=".length));
      if (parsedPort == null) {
        return { ok: false, error: "invalid --port: expected integer" };
      }
      port = parsedPort;
      continue;
    }

    if (arg.startsWith("--")) {
      return { ok: false, error: `unknown option: ${arg}` };
    }

    if (workflowPath) {
      return { ok: false, error: "expected at most one workflow path" };
    }
    workflowPath = resolve(arg);
  }

  return port == null
    ? {
        ok: true,
        workflowPath: workflowPath ?? resolve(cwd, "WORKFLOW.md")
      }
    : {
        ok: true,
        workflowPath: workflowPath ?? resolve(cwd, "WORKFLOW.md"),
        port
      };
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  return Number.parseInt(value, 10);
}
