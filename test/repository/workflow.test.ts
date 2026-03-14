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
    expect(definition.promptTemplate).toContain("{{ issue.id }}");
    expect(definition.promptTemplate).toContain("{{ issue.branchName }}");
    expect(definition.promptTemplate).toContain("{{ issue.identifier }}");
    expect(definition.promptTemplate).toContain(
      "{% if issue.comments.size > 0 %}",
    );
    expect(definition.promptTemplate).toContain(
      "{% for comment in issue.comments %}",
    );
    expect(definition.promptTemplate).toContain("linear_add_issue_comment");
    expect(definition.promptTemplate).toContain(
      "Do not commit directly to `main`",
    );
    expect(definition.promptTemplate).toContain(
      "open or update a GitHub pull request",
    );
    expect(definition.promptTemplate).toContain(
      "Include the GitHub pull request URL in that `linear_add_issue_comment` body",
    );
    expect(definition.promptTemplate).toContain("Linear Issue:");
    expect(definition.promptTemplate).toContain(
      "issues(filter: { identifier: { eq: $identifier } })",
    );
    expect(definition.promptTemplate).toContain(
      "Use that provided id for `linear_add_issue_comment`",
    );
    expect(definition.promptTemplate).toContain(
      "Do not use `linear_graphql` just to look up the current issue id",
    );
    expect(definition.promptTemplate).toContain("Do not use `issueV2(...)`");
    expect(definition.promptTemplate).toContain(
      "Do not use `issue(identifier: ...)`",
    );
    expect(definition.promptTemplate).toContain(
      "Do not use `linear_graphql` to post the completion comment",
    );
  });
});
