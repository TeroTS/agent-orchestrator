import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkflowDefinitionFromPathOrCwd } from "../src/workflow/loader.js";
import { WorkflowStore } from "../src/workflow/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workflow-store-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadWorkflowDefinitionFromPathOrCwd", () => {
  it("uses WORKFLOW.md in the provided cwd when no explicit path is given", async () => {
    const dir = await createTempDir();
    const workflowPath = join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "Prompt from cwd\n", "utf8");

    const workflow = await loadWorkflowDefinitionFromPathOrCwd({ cwd: dir });

    expect(workflow.promptTemplate).toBe("Prompt from cwd");
  });
});

describe("WorkflowStore", () => {
  it("keeps the last known good workflow when a reload becomes invalid", async () => {
    const dir = await createTempDir();
    const workflowPath = join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: literal-token
  project_slug: demo
---
Initial prompt`,
      "utf8",
    );

    const store = new WorkflowStore({ workflowPath });
    const initial = await store.load();
    expect(initial.current.promptTemplate).toBe("Initial prompt");

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: [broken
---
Invalid prompt`,
      "utf8",
    );

    const reload = await store.reload();

    expect(reload.ok).toBe(false);
    expect(store.current().promptTemplate).toBe("Initial prompt");
  });

  it("applies a later valid reload after an invalid one", async () => {
    const dir = await createTempDir();
    const workflowPath = join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "Prompt A", "utf8");

    const store = new WorkflowStore({ workflowPath });
    await store.load();

    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: [broken\n---\nPrompt bad",
      "utf8",
    );
    await store.reload();

    await writeFile(workflowPath, "Prompt B", "utf8");
    const reload = await store.reload();

    expect(reload.ok).toBe(true);
    if (!reload.ok) {
      throw new Error("expected reload to succeed");
    }

    expect(reload.current.promptTemplate).toBe("Prompt B");
    expect(store.current().promptTemplate).toBe("Prompt B");
  });
});
