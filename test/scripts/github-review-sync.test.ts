import { describe, expect, it } from "vitest";

import { TrackerError } from "../../src/tracker/linear-client.js";

const reviewSyncModulePromise =
  // @ts-expect-error plain ESM script imported for unit testing
  import("../../scripts/github-review-sync.mjs") as Promise<{
    buildLinearReviewComment(input: {
      prUrl: string;
      workflowRunId: string;
      reviewRound: number;
      reviewLimit: number;
      limitReached?: boolean;
    }): string;
    countBlockingReviewCycles(
      reviews: Array<{ state?: string | null }>,
    ): number;
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

  it("builds a short Linear review status comment with workflow and PR context", async () => {
    const { buildLinearReviewComment } = await reviewSyncModulePromise;

    const comment = buildLinearReviewComment({
      prUrl: "https://github.com/example/repo/pull/123",
      workflowRunId: "987654321",
      reviewRound: 2,
      reviewLimit: 3,
    });

    expect(comment).toContain("GitHub Review Status");
    expect(comment).toContain("Workflow Run: 987654321");
    expect(comment).toContain("PR: https://github.com/example/repo/pull/123");
    expect(comment).toContain("Review Round: 2/3");
    expect(comment).toContain("See GitHub review for details.");
    expect(comment).not.toContain("tighten retry handling");
  });

  it("marks the comment when the automated review-cycle limit is reached", async () => {
    const { buildLinearReviewComment } = await reviewSyncModulePromise;

    const comment = buildLinearReviewComment({
      prUrl: "https://github.com/example/repo/pull/123",
      workflowRunId: "987654321",
      reviewRound: 4,
      reviewLimit: 3,
      limitReached: true,
    });

    expect(comment).toContain("Review Round: 4/3");
    expect(comment).toContain("Automated review limit reached");
  });

  it("treats CHANGES_REQUESTED as a blocking review state", async () => {
    const { isBlockingReviewState } = await reviewSyncModulePromise;

    expect(isBlockingReviewState("CHANGES_REQUESTED")).toBe(true);
    expect(isBlockingReviewState("APPROVED")).toBe(false);
    expect(isBlockingReviewState("COMMENTED")).toBe(false);
    expect(isBlockingReviewState("DISMISSED")).toBe(false);
    expect(isBlockingReviewState(null)).toBe(false);
  });

  it("counts only CHANGES_REQUESTED reviews toward the blocking cycle limit", async () => {
    const { countBlockingReviewCycles } = await reviewSyncModulePromise;

    expect(
      countBlockingReviewCycles([
        { state: "COMMENTED" },
        { state: "CHANGES_REQUESTED" },
        { state: "APPROVED" },
        { state: "CHANGES_REQUESTED" },
      ]),
    ).toBe(2);
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
