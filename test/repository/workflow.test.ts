import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  loadWorkflowDefinition,
  validateWorkflowForDispatch,
} from "../../src/workflow/loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryWorkflowPath = resolve(here, "../..", "WORKFLOW.md");

describe("repository WORKFLOW.md", () => {
  it("ships a valid default workflow definition for the TypeScript service", async () => {
    process.env.LINEAR_API_KEY = "repo-test-token";

    const definition = await loadWorkflowDefinition({
      workflowPath: repositoryWorkflowPath,
    });
    const validation = validateWorkflowForDispatch(definition);

    expect(validation.ok).toBe(true);
    expect(definition.promptTemplate).not.toContain("cd elixir");
    expect(definition.promptTemplate).toContain("{{ issue.identifier }}");
    expect(definition.promptTemplate).toContain("linear_add_issue_comment");
    expect(definition.promptTemplate).toContain(
      "Do not use `linear_graphql` to post the completion comment",
    );
  });
});
