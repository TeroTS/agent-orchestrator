import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureWorkspace,
  prepareWorkspaceForRun,
  removeWorkspace,
  sanitizeWorkspaceKey,
  validateWorkspacePathWithinRoot,
} from "../../src/workspace/manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function createTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workspace-manager-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("sanitizeWorkspaceKey", () => {
  it("replaces unsupported characters with underscores", () => {
    expect(sanitizeWorkspaceKey("ABC-1/foo bar:baz")).toBe("ABC-1_foo_bar_baz");
  });
});

describe("ensureWorkspace", () => {
  it("creates a deterministic workspace directory and runs after_create once", async () => {
    const root = await createTempRoot();

    const created = await ensureWorkspace({
      workspaceRoot: root,
      issueIdentifier: "ABC-123",
      hooks: {
        afterCreate: "printf created > .created-marker",
      },
    });

    expect(created.createdNow).toBe(true);
    expect(created.workspaceKey).toBe("ABC-123");
    expect(created.path).toBe(join(root, "ABC-123"));
    await expect(
      readFile(join(created.path, ".created-marker"), "utf8"),
    ).resolves.toBe("created");

    const reused = await ensureWorkspace({
      workspaceRoot: root,
      issueIdentifier: "ABC-123",
      hooks: {
        afterCreate: "printf second > .created-marker",
      },
    });

    expect(reused.createdNow).toBe(false);
    await expect(
      readFile(join(reused.path, ".created-marker"), "utf8"),
    ).resolves.toBe("created");
  });

  it("fails safely when the target workspace path exists as a file", async () => {
    const root = await createTempRoot();
    await writeFile(join(root, "ABC-999"), "not a directory", "utf8");

    await expect(
      ensureWorkspace({
        workspaceRoot: root,
        issueIdentifier: "ABC-999",
        hooks: {},
      }),
    ).rejects.toMatchObject({
      code: "workspace_path_not_directory",
    });
  });
});

describe("prepareWorkspaceForRun", () => {
  it("removes temporary artifacts and runs before_run on every attempt", async () => {
    const root = await createTempRoot();
    const workspace = await ensureWorkspace({
      workspaceRoot: root,
      issueIdentifier: "RUN-7",
      hooks: {},
    });

    await mkdir(join(workspace.path, "tmp"));
    await mkdir(join(workspace.path, ".elixir_ls"));

    await prepareWorkspaceForRun({
      workspacePath: workspace.path,
      hooks: {
        beforeRun: "printf ready > .before-run",
      },
    });

    await expect(stat(join(workspace.path, "tmp"))).rejects.toBeDefined();
    await expect(
      stat(join(workspace.path, ".elixir_ls")),
    ).rejects.toBeDefined();
    await expect(
      readFile(join(workspace.path, ".before-run"), "utf8"),
    ).resolves.toBe("ready");
  });

  it("fails the attempt when before_run exits non-zero", async () => {
    const root = await createTempRoot();
    const workspace = await ensureWorkspace({
      workspaceRoot: root,
      issueIdentifier: "RUN-8",
      hooks: {},
    });

    await expect(
      prepareWorkspaceForRun({
        workspacePath: workspace.path,
        hooks: {
          beforeRun: "exit 9",
        },
      }),
    ).rejects.toMatchObject({
      code: "workspace_hook_failed",
    });
  });
});

describe("removeWorkspace", () => {
  it("runs before_remove but still removes the workspace when the hook fails", async () => {
    const root = await createTempRoot();
    const workspace = await ensureWorkspace({
      workspaceRoot: root,
      issueIdentifier: "DEL-1",
      hooks: {},
    });

    await removeWorkspace({
      workspacePath: workspace.path,
      hooks: {
        beforeRemove: "exit 7",
      },
    });

    await expect(stat(workspace.path)).rejects.toBeDefined();
  });
});

describe("validateWorkspacePathWithinRoot", () => {
  it("accepts workspace paths inside the workspace root", () => {
    const root = "/tmp/symphony";
    const workspacePath = "/tmp/symphony/ABC-1";

    expect(() =>
      validateWorkspacePathWithinRoot(root, workspacePath),
    ).not.toThrow();
  });

  it("rejects workspace paths outside the workspace root", () => {
    try {
      validateWorkspacePathWithinRoot(
        "/tmp/symphony",
        "/tmp/somewhere-else/ABC-1",
      );
      throw new Error("expected workspace path validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "workspace_path_outside_root",
      });
    }
  });
});
