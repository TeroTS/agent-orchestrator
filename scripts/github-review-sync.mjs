/* global console, fetch, process */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GITHUB_API_ROOT = "https://api.github.com";
const LINEAR_API_ROOT = "https://api.linear.app/graphql";
const MAX_COMMENT_LENGTH = 8000;
const MAX_REVIEW_ROUNDS = 3;

const { LinearTrackerClient, TrackerError } = await loadTrackerModule();

export function parseLinearIssueIdentifier(body) {
  if (typeof body !== "string") {
    return null;
  }

  const match = /^Linear Issue:\s*([A-Z][A-Z0-9]*-[0-9]+)\s*$/m.exec(
    body.trim(),
  );
  return match?.[1] ?? null;
}

export function buildLinearReviewComment({
  prUrl,
  workflowRunId,
  reviewRound,
  reviewLimit,
  limitReached = false,
}) {
  const body = [
    "GitHub Review Status",
    `Workflow Run: ${workflowRunId}`,
    `PR: ${prUrl}`,
    `Review Round: ${reviewRound}/${reviewLimit}`,
    limitReached
      ? "Automated review limit reached. Issue remains in In Review. See GitHub review for details."
      : "Blocking GitHub review posted. See GitHub review for details.",
  ].join("\n");

  return body.length <= MAX_COMMENT_LENGTH
    ? body
    : `${body.slice(0, MAX_COMMENT_LENGTH - 15)}...(truncated)`;
}

export function isBlockingReviewState(reviewState) {
  return (
    typeof reviewState === "string" &&
    reviewState.toUpperCase() === "CHANGES_REQUESTED"
  );
}

export function countBlockingReviewCycles(reviews) {
  return (Array.isArray(reviews) ? reviews : []).filter((review) =>
    isBlockingReviewState(review?.state),
  ).length;
}

export function formatSyncError(error) {
  if (
    error instanceof TrackerError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      "code" in error &&
      "message" in error &&
      error.name === "TrackerError" &&
      typeof error.code === "string" &&
      typeof error.message === "string")
  ) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

async function loadTrackerModule() {
  try {
    return await import("../src/tracker/linear-client.js");
  } catch {
    return import("../dist/src/tracker/linear-client.js");
  }
}

function setGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  const line = `${name}=${value}\n`;
  appendFileSync(outputPath, line, "utf8");
}

async function fetchGitHubJson(path, token) {
  const response = await fetch(`${GITHUB_API_ROOT}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API responded with HTTP ${response.status} for ${path}`,
    );
  }

  return response.json();
}

async function main() {
  const githubToken = requiredEnv("GITHUB_TOKEN");
  const linearApiKey = requiredEnv("LINEAR_API_KEY");
  const repository =
    process.env.GITHUB_REPOSITORY ?? requiredEnv("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnv("PR_NUMBER"));
  const workflowRunId =
    process.env.GITHUB_RUN_ID ?? requiredEnv("GITHUB_RUN_ID");

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }

  const pr = await fetchGitHubJson(
    `/repos/${repository}/pulls/${prNumber}`,
    githubToken,
  );
  const issueIdentifier = parseLinearIssueIdentifier(pr.body ?? "");
  if (!issueIdentifier) {
    throw new Error(
      "PR body must include a 'Linear Issue: OWN-123' line for review sync.",
    );
  }

  const reviews = await fetchGitHubJson(
    `/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
    githubToken,
  );

  const blockingReviews = (Array.isArray(reviews) ? reviews : []).filter(
    (review) => isBlockingReviewState(review?.state),
  );
  if (blockingReviews.length === 0) {
    setGithubOutput("blocking_review", "false");
    return;
  }

  const reviewRound = countBlockingReviewCycles(reviews);
  const limitReached = reviewRound > MAX_REVIEW_ROUNDS;
  setGithubOutput("blocking_review", "true");

  const commentBody = buildLinearReviewComment({
    prUrl: pr.html_url,
    workflowRunId,
    reviewRound,
    reviewLimit: MAX_REVIEW_ROUNDS,
    limitReached,
  });

  const linearClient = new LinearTrackerClient({
    endpoint: LINEAR_API_ROOT,
    apiKey: linearApiKey,
  });
  const issue =
    await linearClient.fetchIssueContextByIdentifier(issueIdentifier);

  if (
    Array.isArray(issue.comments) &&
    issue.comments.some(
      (comment) =>
        typeof comment?.body === "string" &&
        comment.body.includes(`Workflow Run: ${workflowRunId}`),
    )
  ) {
    return;
  }

  if (
    !limitReached &&
    (typeof issue.state !== "string" || issue.state.toLowerCase() !== "rework")
  ) {
    await linearClient.transitionIssueToState(issue.id, "Rework");
  }

  await linearClient.createIssueComment(issue.id, commentBody);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(formatSyncError(error));
    process.exitCode = 1;
  });
}
