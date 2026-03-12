import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../../src/codex/app-server.js";
import { LinearTrackerClient } from "../../src/tracker/linear-client.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

const realIntegrationEnabled = process.env.SYMPHONY_REAL_INTEGRATION === "1";
const realIt = realIntegrationEnabled ? it : it.skip;

describe("real integration smoke", () => {
  realIt("queries Linear with real credentials", async () => {
    const apiKey = process.env.LINEAR_API_KEY;
    const projectSlug = process.env.SYMPHONY_LINEAR_PROJECT_SLUG;
    if (!apiKey || !projectSlug) {
      throw new Error(
        "LINEAR_API_KEY and SYMPHONY_LINEAR_PROJECT_SLUG are required",
      );
    }

    const client = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey,
      projectSlug,
    });

    const issues = await client.fetchIssuesByStates(["Todo"]);
    expect(Array.isArray(issues)).toBe(true);
  });

  realIt("starts a real Codex app-server session", async () => {
    const codexPath = spawnSync("bash", ["-lc", "command -v codex"], {
      encoding: "utf8",
    });
    if (codexPath.status !== 0) {
      throw new Error(
        "codex command is required for real integration smoke tests",
      );
    }

    const workspacePath = await mkdtemp(join(tmpdir(), "symphony-real-codex-"));
    tempDirs.push(workspacePath);

    const client = new CodexAppServerClient({
      command: process.env.SYMPHONY_CODEX_COMMAND ?? "codex app-server",
      workspacePath,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 5000,
      turnTimeoutMs: 60000,
    });

    try {
      await client.start();
      const result = await client.runTurn({
        prompt: "Reply with READY and stop.",
        title: "SMOKE-1: Real Codex session",
      });
      expect(result.outcome).toBe("completed");
    } finally {
      await client.stop();
    }
  });
});
