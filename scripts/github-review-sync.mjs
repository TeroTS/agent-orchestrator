/* global console, fetch, process */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GITHUB_API_ROOT = "https://api.github.com";
const LINEAR_API_ROOT = "https://api.linear.app/graphql";
const MAX_FEEDBACK_LINES = 20;
const MAX_COMMENT_LENGTH = 8000;

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
  feedbackLines,
}) {
  const lines =
    feedbackLines.length > 0
      ? feedbackLines
      : ["Blocking review failed. Inspect the PR review comments for details."];
  const body = [
    "GitHub Review Feedback",
    `Workflow Run: ${workflowRunId}`,
    `PR: ${prUrl}`,
    "",
    "Summary:",
    ...lines.map((line) => `- ${line}`),
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

function collectFeedbackLines({ reviews, reviewComments, since }) {
  const sinceEpoch = Date.parse(since);
  const lines = [];

  for (const review of reviews) {
    const submittedAt = Date.parse(review.submitted_at ?? "");
    const body = normalizeText(review.body);
    if (
      !Number.isNaN(sinceEpoch) &&
      !Number.isNaN(submittedAt) &&
      submittedAt < sinceEpoch
    ) {
      continue;
    }
    if (body) {
      lines.push(`Review body: ${body}`);
    }
  }

  for (const comment of reviewComments) {
    const createdAt = Date.parse(comment.created_at ?? "");
    const body = normalizeText(comment.body);
    if (
      !Number.isNaN(sinceEpoch) &&
      !Number.isNaN(createdAt) &&
      createdAt < sinceEpoch
    ) {
      continue;
    }
    if (!body) {
      continue;
    }

    const location = [comment.path, comment.line ?? comment.original_line]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .join(":");
    lines.push(location ? `${location} ${body}` : body);
  }

  return lines.slice(0, MAX_FEEDBACK_LINES);
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

async function fetchLinearJson({ query, variables, apiKey }) {
  const response = await fetch(LINEAR_API_ROOT, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API responded with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error("Linear API returned GraphQL errors.");
  }

  return payload;
}

async function resolveLinearIssue({ apiKey, issueIdentifier }) {
  const payload = await fetchLinearJson({
    apiKey,
    query: `
      query ReviewBridgeIssue($identifier: String!, $commentsFirst: Int!) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes {
            id
            identifier
            state {
              name
            }
            team {
              states {
                nodes {
                  id
                  name
                }
              }
            }
            comments(first: $commentsFirst) {
              nodes {
                body
              }
            }
          }
        }
      }
    `,
    variables: {
      identifier: issueIdentifier,
      commentsFirst: 20,
    },
  });

  const issue = payload.data?.issues?.nodes?.[0];
  if (!issue?.id) {
    throw new Error(`Unable to resolve Linear issue ${issueIdentifier}.`);
  }

  return issue;
}

async function transitionLinearIssueToState({ apiKey, issueId, stateId }) {
  const payload = await fetchLinearJson({
    apiKey,
    query: `
      mutation MoveIssueToState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `,
    variables: {
      id: issueId,
      stateId,
    },
  });

  if (!payload.data?.issueUpdate?.success) {
    throw new Error(
      `Unable to transition Linear issue ${issueId} to the requested state.`,
    );
  }
}

async function createLinearComment({ apiKey, issueId, body }) {
  const payload = await fetchLinearJson({
    apiKey,
    query: `
      mutation CreateIssueComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `,
    variables: {
      issueId,
      body,
    },
  });

  if (!payload.data?.commentCreate?.success) {
    throw new Error(`Unable to create Linear comment for issue ${issueId}.`);
  }
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

async function main() {
  const githubToken = requiredEnv("GITHUB_TOKEN");
  const linearApiKey = requiredEnv("LINEAR_API_KEY");
  const repository =
    process.env.GITHUB_REPOSITORY ?? requiredEnv("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnv("PR_NUMBER"));
  const reviewStartedAt = requiredEnv("REVIEW_STARTED_AT");
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

  const [reviews, reviewComments] = await Promise.all([
    fetchGitHubJson(
      `/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
      githubToken,
    ),
    fetchGitHubJson(
      `/repos/${repository}/pulls/${prNumber}/comments?per_page=100`,
      githubToken,
    ),
  ]);

  const blockingReviews = (Array.isArray(reviews) ? reviews : []).filter(
    (review) => isBlockingReviewState(review?.state),
  );
  if (blockingReviews.length === 0) {
    setGithubOutput("blocking_review", "false");
    return;
  }

  const feedbackLines = collectFeedbackLines({
    reviews: blockingReviews,
    reviewComments: Array.isArray(reviewComments) ? reviewComments : [],
    since: reviewStartedAt,
  });
  setGithubOutput("blocking_review", "true");

  const commentBody = buildLinearReviewComment({
    prUrl: pr.html_url,
    workflowRunId,
    feedbackLines,
  });

  const issue = await resolveLinearIssue({
    apiKey: linearApiKey,
    issueIdentifier,
  });

  if (
    Array.isArray(issue.comments?.nodes) &&
    issue.comments.nodes.some(
      (comment) =>
        typeof comment?.body === "string" &&
        comment.body.includes(`Workflow Run: ${workflowRunId}`),
    )
  ) {
    return;
  }

  const reworkState = issue.team?.states?.nodes?.find(
    (state) =>
      typeof state?.name === "string" && state.name.toLowerCase() === "rework",
  );
  if (!reworkState?.id) {
    throw new Error(
      `Linear issue ${issueIdentifier} does not have a Rework state.`,
    );
  }

  if (issue.state?.name?.toLowerCase() !== "rework") {
    await transitionLinearIssueToState({
      apiKey: linearApiKey,
      issueId: issue.id,
      stateId: reworkState.id,
    });
  }

  await createLinearComment({
    apiKey: linearApiKey,
    issueId: issue.id,
    body: commentBody,
  });
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
