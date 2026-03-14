export function parseLinearIssueIdentifier(
  body: string | null | undefined,
): string | null;

export function buildLinearReviewComment(input: {
  prUrl: string;
  workflowRunId: string;
  feedbackLines: string[];
}): string;
