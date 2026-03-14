import { describe, expect, it } from "vitest";

const reviewSyncModulePromise =
  // @ts-expect-error plain ESM script imported for unit testing
  import("../../scripts/github-review-sync.mjs") as Promise<{
    buildLinearReviewComment(input: {
      prUrl: string;
      workflowRunId: string;
      feedbackLines: string[];
    }): string;
    parseLinearIssueIdentifier(body: string | null | undefined): string | null;
  }>;

describe("github-review-sync", () => {
  it("parses the Linear issue identifier from the PR body", async () => {
    const { parseLinearIssueIdentifier } = await reviewSyncModulePromise;

    expect(
      parseLinearIssueIdentifier(`
Linear Issue: OWN-123

#### Summary
- Example
`),
    ).toBe("OWN-123");
  });

  it("builds a review feedback comment with workflow and PR context", async () => {
    const { buildLinearReviewComment } = await reviewSyncModulePromise;

    const comment = buildLinearReviewComment({
      prUrl: "https://github.com/example/repo/pull/123",
      workflowRunId: "987654321",
      feedbackLines: [
        "Review body: tighten retry handling.",
        "src/app.ts:42 Missing regression test.",
      ],
    });

    expect(comment).toContain("GitHub Review Feedback");
    expect(comment).toContain("Workflow Run: 987654321");
    expect(comment).toContain("PR: https://github.com/example/repo/pull/123");
    expect(comment).toContain("tighten retry handling");
    expect(comment).toContain("Missing regression test");
  });
});
