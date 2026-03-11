import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("repository source layout", () => {
  it("groups related runtime modules under feature directories", async () => {
    const expectedFiles = [
      "src/app/cli.ts",
      "src/app/host.ts",
      "src/app/main.ts",
      "src/app/service.ts",
      "src/codex/agent-runner.ts",
      "src/codex/app-server.ts",
      "src/observability/status-server.ts",
      "src/observability/structured-logger.ts",
      "src/orchestrator/orchestrator.ts",
      "src/orchestrator/rules.ts",
      "src/orchestrator/state.ts",
      "src/workflow/loader.ts",
      "src/workflow/store.ts",
      "src/workspace/manager.ts",
    ];

    for (const relativePath of expectedFiles) {
      await expect(exists(resolve(repoRoot, relativePath))).resolves.toBe(true);
    }

    await expect(
      exists(resolve(repoRoot, "src/agent-runner.ts")),
    ).resolves.toBe(false);
    await expect(
      exists(resolve(repoRoot, "src/orchestrator.ts")),
    ).resolves.toBe(false);
    await expect(
      exists(resolve(repoRoot, "src/workflow-loader.ts")),
    ).resolves.toBe(false);
  });
});
