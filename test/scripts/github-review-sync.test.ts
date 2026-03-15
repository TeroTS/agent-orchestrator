import { describe, expect, it } from "vitest";

import { TrackerError } from "../../src/tracker/linear-client.js";

const reviewSyncModulePromise =
  // @ts-expect-error plain ESM script imported for unit testing
  import("../../scripts/github-review-sync.mjs") as Promise<{
    buildLinearReviewComment(input: {
      prUrl: string;
      workflowRunId: string;
      feedbackLines: string[];
    }): string;
    formatSyncError(error: unknown): string;
    isBlockingReviewState(reviewState: string | null | undefined): boolean;
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

  it("treats CHANGES_REQUESTED as a blocking review state", async () => {
    const { isBlockingReviewState } = await reviewSyncModulePromise;

    expect(isBlockingReviewState("CHANGES_REQUESTED")).toBe(true);
    expect(isBlockingReviewState("APPROVED")).toBe(false);
    expect(isBlockingReviewState("COMMENTED")).toBe(false);
    expect(isBlockingReviewState("DISMISSED")).toBe(false);
    expect(isBlockingReviewState(null)).toBe(false);
  });

  it("formats tracker failures with the error code for action logs", async () => {
    const { formatSyncError } = await reviewSyncModulePromise;

    expect(
      formatSyncError(
        new TrackerError(
          "linear_api_status",
          "Linear responded with HTTP 400 while executing IssueContextByIdentifier.",
        ),
      ),
    ).toContain("linear_api_status");
    expect(
      formatSyncError(
        new TrackerError(
          "linear_api_status",
          "Linear responded with HTTP 400 while executing IssueContextByIdentifier.",
        ),
      ),
    ).toContain("IssueContextByIdentifier");
  });
});
