import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  loadWorkflowDefinition,
  renderPromptTemplate,
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
    expect(definition.promptTemplate).toContain("Ticket context:");
    expect(definition.promptTemplate).toContain(
      "{% if issue.comments.size > 0 %}",
    );
    expect(definition.promptTemplate).toContain(
      "{% for comment in issue.comments %}",
    );
    expect(definition.promptTemplate).toContain(
      "Latest GitHub review feedback:",
    );
    expect(definition.promptTemplate).toContain(
      "{% if issue.githubReviewComments.size > 0 or issue.githubReviewSummary %}",
    );
    expect(definition.promptTemplate).toContain("complete_ticket_delivery");
    expect(definition.promptTemplate).toContain(
      "Do not commit directly to `main`",
    );
    expect(definition.promptTemplate).toContain(
      "open or update a GitHub pull request",
    );
    expect(definition.promptTemplate).toContain(
      "Work only inside the provided workspace for this ticket",
    );
    expect(definition.promptTemplate).toContain("Work on a ticket branch");
    expect(definition.promptTemplate).toContain(
      "Use the repository's standard push/publish workflow from the local `push` skill",
    );
    expect(definition.promptTemplate).toContain(
      "Do not create GitHub issues for ticket delivery",
    );
    expect(definition.promptTemplate).toContain(
      "call `complete_ticket_delivery` exactly once",
    );
    expect(definition.promptTemplate).toContain(
      "it runs `./scripts/verify` before publishing",
    );
    expect(definition.promptTemplate).toContain(
      "targeted validation checks you ran beyond `./scripts/verify`",
    );
    expect(definition.promptTemplate).not.toContain(
      'gh pr list --head "$branch" --state open --json number,url',
    );
    expect(definition.promptTemplate).not.toContain(
      'gh pr create --base main --head "$branch"',
    );
    expect(definition.promptTemplate).not.toContain(
      "gh pr view --json url -q .url",
    );
    expect(definition.promptTemplate).toContain("Linear Issue:");
    expect(definition.promptTemplate).toContain('issue(id: "OWN-15")');
    expect(definition.promptTemplate).toContain(
      "Reuse that provided id for tracker operations",
    );
    expect(definition.promptTemplate).toContain(
      "Do not use `linear_graphql` just to look up the current ticket id when the provided `Ticket ID` is already sufficient",
    );
    expect(definition.promptTemplate).toContain("Do not use `issueV2(...)`");
    expect(definition.promptTemplate).toContain(
      "Do not use `issue(identifier: ...)`",
    );
    expect(definition.promptTemplate).toContain(
      "Do not call `linear_add_issue_comment` directly for normal ticket completion",
    );
    expect(definition.promptTemplate).toContain(
      "posts the final Linear completion comment with the PR URL",
    );
  });

  it("renders the default workflow prompt template with review feedback context", async () => {
    process.env.LINEAR_API_KEY = "repo-test-token";

    const definition = await loadWorkflowDefinition({
      workflowPath: repositoryWorkflowPath,
    });

    const rendered = await renderPromptTemplate(definition, {
      issue: {
        id: "issue-1",
        branchName: "terosuhonen/own-42-fix",
        identifier: "OWN-42",
        title: "Fix review loop",
        state: "Rework",
        labels: ["bugfix"],
        url: "https://linear.app/example/issue/OWN-42",
        description: "Fix the broken review prompt.",
        comments: [
          {
            id: "comment-1",
            body: "Linear breadcrumb",
            url: null,
            authorName: "symphony",
            createdAt: null,
          },
        ],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
        githubReviewSummary: "Reviewer asked for a syntax fix.",
        githubReviewRound: 2,
        githubReviewUrl: "https://github.com/example/repo/pull/42",
        githubReviewComments: [
          {
            id: "review-comment-1",
            body: "WORKFLOW.md: use Liquid-compatible syntax",
            url: null,
            authorName: "claude[bot]",
            createdAt: null,
          },
        ],
      },
      attempt: 1,
    });

    expect(rendered).toContain("Latest GitHub review feedback:");
    expect(rendered).toContain("Review round: 2");
    expect(rendered).toContain("Reviewer asked for a syntax fix.");
    expect(rendered).toContain("WORKFLOW.md: use Liquid-compatible syntax");
  });
});
