import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadWorkflowDefinition,
  renderPromptTemplate,
  validateWorkflowForDispatch,
  type WorkflowDefinition,
} from "../../src/workflow/loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
  delete process.env.LINEAR_API_KEY;
});

async function withWorkflowFile(
  contents: string,
  filename = "WORKFLOW.md",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workflow-loader-test-"));
  tempDirs.push(dir);
  const filePath = join(dir, filename);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("loadWorkflowDefinition", () => {
  it("loads yaml front matter and trims the prompt body", async () => {
    const workflowPath = await withWorkflowFile(`---
tracker:
  kind: linear
  project_slug: demo
polling:
  interval_ms: "1500"
---

You are working on {{ issue.identifier }}.
`);

    const workflow = await loadWorkflowDefinition({ workflowPath });

    expect(workflow).toEqual<WorkflowDefinition>({
      config: {
        tracker: {
          kind: "linear",
          project_slug: "demo",
        },
        polling: {
          interval_ms: "1500",
        },
      },
      promptTemplate: "You are working on {{ issue.identifier }}.",
    });
  });

  it("treats a workflow without front matter as prompt-only", async () => {
    const workflowPath = await withWorkflowFile("Hello from prompt only.\n");

    const workflow = await loadWorkflowDefinition({ workflowPath });

    expect(workflow.config).toEqual({});
    expect(workflow.promptTemplate).toBe("Hello from prompt only.");
  });

  it("fails when the workflow file is missing", async () => {
    await expect(
      loadWorkflowDefinition({
        workflowPath: join(tmpdir(), "missing-workflow.md"),
      }),
    ).rejects.toMatchObject({
      code: "missing_workflow_file",
    });
  });

  it("fails when front matter yaml is not an object", async () => {
    const workflowPath = await withWorkflowFile(`---
- not
- a
- map
---
body`);

    await expect(
      loadWorkflowDefinition({ workflowPath }),
    ).rejects.toMatchObject({
      code: "workflow_front_matter_not_a_map",
    });
  });

  it("fails when front matter yaml is invalid", async () => {
    const workflowPath = await withWorkflowFile(`---
tracker:
  kind: [oops
---
body`);

    await expect(
      loadWorkflowDefinition({ workflowPath }),
    ).rejects.toMatchObject({
      code: "workflow_parse_error",
    });
  });
});

describe("validateWorkflowForDispatch", () => {
  it("applies defaults and resolves env-backed tracker api keys", () => {
    process.env.LINEAR_API_KEY = "linear-secret";

    const validation = validateWorkflowForDispatch({
      config: {
        tracker: {
          kind: "linear",
          project_slug: "demo",
          api_key: "$LINEAR_API_KEY",
        },
      },
      promptTemplate: "Prompt",
    });

    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error("expected validation success");
    }

    expect(validation.config.tracker.apiKey).toBe("linear-secret");
    expect(validation.config.tracker.endpoint).toBe(
      "https://api.linear.app/graphql",
    );
    expect(validation.config.tracker.dispatchState).toBe("In Progress");
    expect(validation.config.tracker.handoffState).toBe("In Review");
    expect(validation.config.polling.intervalMs).toBe(30000);
    expect(validation.config.workspace.root).toContain("symphony_workspaces");
    expect(validation.config.codex.command).toBe("codex app-server");
  });

  it("reads configurable dispatch and handoff states from workflow config", () => {
    const validation = validateWorkflowForDispatch({
      config: {
        tracker: {
          kind: "linear",
          project_slug: "demo",
          api_key: "token",
          dispatch_state: "Started",
          handoff_state: "Review",
        },
      },
      promptTemplate: "Prompt",
    });

    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error("expected validation success");
    }

    expect(validation.config.tracker.dispatchState).toBe("Started");
    expect(validation.config.tracker.handoffState).toBe("Review");
  });

  it("fails preflight when required dispatch fields are missing", () => {
    const validation = validateWorkflowForDispatch({
      config: {
        tracker: {
          kind: "linear",
        },
      },
      promptTemplate: "Prompt",
    });

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        "tracker.api_key is required",
        "tracker.project_slug is required",
      ],
    });
  });
});

describe("renderPromptTemplate", () => {
  it("renders issue fields and attempt in strict mode", async () => {
    const rendered = await renderPromptTemplate(
      {
        config: {},
        promptTemplate: "Issue {{ issue.identifier }} attempt {{ attempt }}",
      },
      {
        issue: {
          identifier: "ABC-123",
        },
        attempt: 2,
      },
    );

    expect(rendered).toBe("Issue ABC-123 attempt 2");
  });

  it("fails on unknown variables", async () => {
    await expect(
      renderPromptTemplate(
        {
          config: {},
          promptTemplate: "Missing {{ issue.unknown_field }}",
        },
        {
          issue: {
            identifier: "ABC-123",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "template_render_error",
    });
  });

  it("fails with template_parse_error on invalid template syntax", async () => {
    await expect(
      renderPromptTemplate(
        {
          config: {},
          promptTemplate: "{% if issue.identifier %}",
        },
        {
          issue: {
            identifier: "ABC-123",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "template_parse_error",
    });
  });
});
