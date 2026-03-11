import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export interface WorkspaceHooks {
  afterCreate?: string | undefined;
  beforeRun?: string | undefined;
  afterRun?: string | undefined;
  beforeRemove?: string | undefined;
  timeoutMs?: number;
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface EnsureWorkspaceOptions {
  workspaceRoot: string;
  issueIdentifier: string;
  hooks: WorkspaceHooks;
}

export interface PrepareWorkspaceForRunOptions {
  workspacePath: string;
  hooks: WorkspaceHooks;
}

export interface RemoveWorkspaceOptions {
  workspacePath: string;
  hooks: WorkspaceHooks;
}

export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

const DEFAULT_HOOK_TIMEOUT_MS = 60000;
const TEMPORARY_ARTIFACTS = ["tmp", ".elixir_ls"];

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspacePathFor(
  workspaceRoot: string,
  issueIdentifier: string,
): string {
  return join(workspaceRoot, sanitizeWorkspaceKey(issueIdentifier));
}

export function validateWorkspacePathWithinRoot(
  workspaceRoot: string,
  workspacePath: string,
): void {
  const absoluteRoot = resolve(workspaceRoot);
  const absoluteWorkspacePath = resolve(workspacePath);
  const rootedPrefix = absoluteRoot.endsWith("/")
    ? absoluteRoot
    : `${absoluteRoot}/`;

  if (
    absoluteWorkspacePath !== absoluteRoot &&
    !absoluteWorkspacePath.startsWith(rootedPrefix)
  ) {
    throw new WorkspaceError(
      "workspace_path_outside_root",
      `Workspace path ${absoluteWorkspacePath} is outside ${absoluteRoot}`,
    );
  }
}

export async function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): Promise<WorkspaceInfo> {
  const workspaceKey = sanitizeWorkspaceKey(options.issueIdentifier);
  const path = workspacePathFor(options.workspaceRoot, options.issueIdentifier);
  validateWorkspacePathWithinRoot(options.workspaceRoot, path);

  await mkdir(options.workspaceRoot, { recursive: true });

  const existing = await statIfExists(path);
  if (existing?.isFile()) {
    throw new WorkspaceError(
      "workspace_path_not_directory",
      `Workspace path ${path} already exists and is not a directory.`,
    );
  }

  const createdNow = !existing;
  if (createdNow) {
    await mkdir(path, { recursive: true });

    try {
      await runHook(
        "after_create",
        options.hooks.afterCreate,
        path,
        options.hooks.timeoutMs,
      );
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    path,
    workspaceKey,
    createdNow,
  };
}

export async function prepareWorkspaceForRun(
  options: PrepareWorkspaceForRunOptions,
): Promise<void> {
  for (const artifact of TEMPORARY_ARTIFACTS) {
    await rm(join(options.workspacePath, artifact), {
      recursive: true,
      force: true,
    });
  }

  await runHook(
    "before_run",
    options.hooks.beforeRun,
    options.workspacePath,
    options.hooks.timeoutMs,
  );
}

export async function finalizeWorkspaceRun(
  options: PrepareWorkspaceForRunOptions,
): Promise<void> {
  try {
    await runHook(
      "after_run",
      options.hooks.afterRun,
      options.workspacePath,
      options.hooks.timeoutMs,
    );
  } catch {
    // Intentionally ignored by contract.
  }
}

export async function removeWorkspace(
  options: RemoveWorkspaceOptions,
): Promise<void> {
  try {
    await runHook(
      "before_remove",
      options.hooks.beforeRemove,
      options.workspacePath,
      options.hooks.timeoutMs,
    );
  } catch {
    // Intentionally ignored by contract.
  }

  await rm(options.workspacePath, { recursive: true, force: true });
}

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function runHook(
  hookName: "after_create" | "before_run" | "after_run" | "before_remove",
  script: string | undefined,
  cwd: string,
  timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<void> {
  if (!script?.trim()) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("sh", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new WorkspaceError(
          "workspace_hook_failed",
          `${hookName} hook failed to start.`,
          {
            cause: error,
          },
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        rejectPromise(
          new WorkspaceError(
            "workspace_hook_timed_out",
            `${hookName} hook timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }

      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new WorkspaceError(
          "workspace_hook_failed",
          `${hookName} hook failed with exit code ${code ?? "unknown"}${
            signal ? ` (${signal})` : ""
          }: ${stderr || stdout}`.trim(),
        ),
      );
    });
  });
}
