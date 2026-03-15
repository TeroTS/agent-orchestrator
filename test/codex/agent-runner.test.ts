import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunner } from "../../src/codex/agent-runner.js";
import type { WorkflowDefinition } from "../../src/workflow/loader.js";
import type { OrchestrationIssue } from "../../src/orchestrator/rules.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe("AgentRunner", () => {
  it("creates a workspace, runs a turn, refreshes tracker state, and stops when the issue becomes terminal", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const promptLogPath = process.env.PROMPT_LOG_PATH;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnCount = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    turnCount += 1;
    const prompt = msg.params.input[0].text;
    await appendFile(promptLogPath, JSON.stringify(prompt) + "\\n", "utf8");
    send({ id: msg.id, result: { turn: { id: "turn-" + turnCount } } });
      send({
        id: "tool-comment-1",
        method: "item/tool/call",
        params: {
          tool: "linear_add_issue_comment",
          callId: "call-comment-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            issueId: "issue-1",
            body: "Implemented the requested change and validated it."
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const tracker = {
      fetchIssueStatesByIds: vi
        .fn()
        .mockResolvedValueOnce([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" }),
        ]),
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: tracker.fetchIssueStatesByIds,
      linearFetchFn: mockLinearCommentFetch(),
    });

    const result = await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
      }),
      attempt: null,
    });

    expect(result).toEqual({ reason: "normal" });
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledWith(["issue-1"]);
    const prompts = (await readFile(promptLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(prompts[0]).toContain("ABC-1");
  });

  it("stops after the first successful turn even if the issue is still active", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const promptLogPath = process.env.PROMPT_LOG_PATH;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnCount = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    turnCount += 1;
    const prompt = msg.params.input[0].text;
    await appendFile(promptLogPath, JSON.stringify(prompt) + "\\n", "utf8");
    send({ id: msg.id, result: { turn: { id: "turn-" + turnCount } } });
      send({
        id: "tool-comment-1",
        method: "item/tool/call",
        params: {
          tool: "linear_add_issue_comment",
          callId: "call-comment-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            issueId: "issue-1",
            body: "Implemented the requested change and validated it."
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const tracker = {
      fetchIssueStatesByIds: vi.fn().mockResolvedValueOnce([
        makeIssue({
          id: "issue-1",
          identifier: "ABC-1",
          state: "In Progress",
        }),
      ]),
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
        3,
      ),
      issueStateRefresher: tracker.fetchIssueStatesByIds,
      linearFetchFn: mockLinearCommentFetch(),
    });

    const result = await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
      }),
      attempt: 1,
    });

    expect(result).toEqual({ reason: "normal" });
    const prompts = (await readFile(promptLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(prompts).toHaveLength(1);
  });

  it("renders fetched issue comments into the prompt before the run starts", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const promptLogPath = process.env.PROMPT_LOG_PATH;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    await appendFile(promptLogPath, JSON.stringify(msg.params.input[0].text) + "\\n", "utf8");
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({
      id: "tool-comment-1",
      method: "item/tool/call",
      params: {
        tool: "linear_add_issue_comment",
        callId: "call-comment-1",
        threadId: "thread-1",
        turnId: "turn-1",
        arguments: {
          issueId: "issue-1",
          body: "Implemented the requested change and validated it. PR: https://github.com/example/repo/pull/123"
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" }),
        ]),
      issueContextFetcher: vi.fn().mockResolvedValue(
        makeIssue({
          id: "issue-1",
          identifier: "ABC-1",
          state: "Rework",
          comments: [
            {
              id: "comment-1",
              body: "Linear status: see GitHub review for details.",
              url: "https://linear.app/demo/comment/comment-1",
              authorName: "Claude Reviewer",
              createdAt: new Date("2026-03-14T12:00:00.000Z"),
            },
          ],
        }),
      ),
      githubReviewFeedbackFetcher: vi.fn().mockResolvedValue({
        reviewRound: 2,
        reviewUrl: "https://github.com/example/repo/pull/123",
        summary: "Not approved because retry handling still misses a guard.",
        comments: [
          {
            id: "review-comment-1",
            body: "Retry guard still misses the aborted-session branch.",
            url: "https://github.com/example/repo/pull/123#discussion_r1",
            authorName: "claude[bot]",
            createdAt: new Date("2026-03-14T12:05:00.000Z"),
          },
        ],
      }),
      linearFetchFn: mockLinearCommentFetch(),
    });

    await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
      }),
      attempt: null,
    });

    const prompts = (await readFile(promptLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(prompts[0]).toContain(
      "Linear status: see GitHub review for details.",
    );
    expect(prompts[0]).toContain(
      "Not approved because retry handling still misses a guard.",
    );
    expect(prompts[0]).toContain(
      "Retry guard still misses the aborted-session branch.",
    );
  });

  it("does not fetch GitHub review feedback outside Rework runs", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");
    const githubReviewFeedbackFetcher = vi.fn();

    await writeFile(
      scriptPath,
      `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const promptLogPath = process.env.PROMPT_LOG_PATH;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    await appendFile(promptLogPath, JSON.stringify(msg.params.input[0].text) + "\\n", "utf8");
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({
      id: "tool-comment-1",
      method: "item/tool/call",
      params: {
        tool: "linear_add_issue_comment",
        callId: "call-comment-1",
        threadId: "thread-1",
        turnId: "turn-1",
        arguments: {
          issueId: "issue-1",
          body: "Implemented the requested change and validated it. PR: https://github.com/example/repo/pull/123"
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" }),
        ]),
      issueContextFetcher: vi.fn().mockResolvedValue(
        makeIssue({
          id: "issue-1",
          identifier: "ABC-1",
          state: "In Progress",
        }),
      ),
      githubReviewFeedbackFetcher,
      linearFetchFn: mockLinearCommentFetch(),
    });

    await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
      }),
      attempt: null,
    });

    expect(githubReviewFeedbackFetcher).not.toHaveBeenCalled();
  });

  it("logs run attempt lifecycle events", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
      send({
        id: "tool-comment-1",
        method: "item/tool/call",
        params: {
          tool: "linear_add_issue_comment",
          callId: "call-comment-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            issueId: "issue-1",
            body: "Implemented the requested change and validated it."
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" }),
        ]),
      linearFetchFn: mockLinearCommentFetch(),
      logger,
    });

    await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "In Progress",
      }),
      attempt: null,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "run attempt started",
      expect.objectContaining({
        issue_id: "issue-1",
        issue_identifier: "ABC-1",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "run attempt completed",
      expect.objectContaining({
        issue_id: "issue-1",
        issue_identifier: "ABC-1",
      }),
    );
  });

  it("advertises the linear_graphql tool to the app-server using workflow tracker auth", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const threadStartLogPath = join(appServerDir, "thread-start.json");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import { writeFile } from "node:fs/promises";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const threadStartLogPath = process.env.THREAD_START_LOG_PATH;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    await writeFile(threadStartLogPath, JSON.stringify(msg.params), "utf8");
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
      send({
        id: "tool-comment-1",
        method: "item/tool/call",
        params: {
          tool: "linear_add_issue_comment",
          callId: "call-comment-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            issueId: "issue-1",
            body: "Implemented the requested change and validated it."
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    process.env.THREAD_START_LOG_PATH = threadStartLogPath;

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi
        .fn()
        .mockResolvedValue([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" }),
        ]),
      linearFetchFn: mockLinearCommentFetch(),
    });

    await runner.runAttempt({
      issue: makeIssue({
        id: "issue-1",
        identifier: "ABC-1",
        state: "Todo",
      }),
      attempt: null,
    });

    const threadStartParams = JSON.parse(
      await readFile(threadStartLogPath, "utf8"),
    );
    expect(threadStartParams.dynamicTools).toEqual([
      expect.objectContaining({
        name: "linear_graphql",
        inputSchema: expect.any(Object),
      }),
      expect.objectContaining({
        name: "linear_add_issue_comment",
        inputSchema: expect.any(Object),
      }),
      expect.objectContaining({
        name: "complete_ticket_delivery",
        inputSchema: expect.any(Object),
      }),
    ]);
    expect(threadStartParams.tools).toEqual([
      expect.objectContaining({
        name: "linear_graphql",
      }),
      expect.objectContaining({
        name: "linear_add_issue_comment",
      }),
    ]);
  });

  it("requires a completion comment before treating the run as successful", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi.fn().mockResolvedValue([]),
    });

    await expect(
      runner.runAttempt({
        issue: makeIssue({
          id: "issue-1",
          identifier: "ABC-1",
          state: "In Progress",
        }),
        attempt: null,
      }),
    ).rejects.toMatchObject({
      message: "Codex did not post a completion comment.",
    });
  });

  it("requires a GitHub PR URL in the completion comment before treating the run as successful", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
      send({
        id: "tool-comment-1",
        method: "item/tool/call",
        params: {
          tool: "linear_add_issue_comment",
          callId: "call-comment-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            issueId: "issue-1",
            body: "Implemented the requested change and validated it."
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi.fn().mockResolvedValue([]),
      linearFetchFn: mockLinearCommentFetch(
        "Implemented the requested change and validated it.",
      ),
    });

    await expect(
      runner.runAttempt({
        issue: makeIssue({
          id: "issue-1",
          identifier: "ABC-1",
          state: "In Progress",
        }),
        attempt: null,
      }),
    ).rejects.toMatchObject({
      message:
        "Codex did not include a GitHub PR URL in the completion comment.",
    });
  });

  it("treats runtime-owned ticket delivery as the success path", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({
      id: "tool-delivery-1",
      method: "item/tool/call",
      params: {
        tool: "complete_ticket_delivery",
        callId: "call-delivery-1",
        threadId: "thread-1",
        turnId: "turn-1",
        arguments: {
          summary: "Added the requested files.",
          targeted_checks: ["Verified the files exist."]
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const commandRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "terosuhonen/own-28-add-new-files\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "A  testing_0.txt\nA  testing_1.txt\nA  testing_2.txt\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout:
          "[terosuhonen/own-28-add-new-files abc1234] OWN-28: Add new files\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "TeroTS/agent-orchestrator\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "https://github.com/TeroTS/agent-orchestrator/pull/6\n",
        stderr: "",
        exitCode: 0,
      });

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi.fn().mockResolvedValue([]),
      deliveryCommandRunner: commandRunner,
      templateReadFile: vi
        .fn()
        .mockResolvedValue(`Linear Issue: <!-- OWN-123 -->`),
      linearFetchFn: mockLinearCommentFetch(
        "Added the requested files. Validation: Verified the files exist. PR: https://github.com/TeroTS/agent-orchestrator/pull/6",
      ),
    });

    await expect(
      runner.runAttempt({
        issue: makeIssue({
          id: "issue-1",
          identifier: "OWN-28",
          title: "Add new files",
          branchName: "terosuhonen/own-28-add-new-files",
          url: "https://linear.app/demo/issue/OWN-28",
          state: "In Progress",
        }),
        attempt: null,
      }),
    ).resolves.toEqual({ reason: "normal" });
  });

  it("fails the run with the verify error when complete_ticket_delivery cannot publish", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agent-runner-workspace-"),
    );
    tempDirs.push(workspaceRoot);
    const appServerDir = await mkdtemp(join(tmpdir(), "agent-runner-server-"));
    tempDirs.push(appServerDir);
    const promptLogPath = join(appServerDir, "prompts.log");
    const scriptPath = join(appServerDir, "fake-app-server.mjs");

    await writeFile(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1" } } });
    send({
      id: "tool-delivery-1",
      method: "item/tool/call",
      params: {
        tool: "complete_ticket_delivery",
        callId: "call-delivery-1",
        threadId: "thread-1",
        turnId: "turn-1",
        arguments: {
          summary: "Added the requested files.",
          targeted_checks: ["Verified the files exist."]
        }
      }
    });
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8",
    );

    const commandRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "terosuhonen/own-28-add-new-files\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "A  testing_0.txt\nA  testing_1.txt\nA  testing_2.txt\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "listen EPERM 127.0.0.1",
        exitCode: 1,
      });

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(
        workspaceRoot,
        `${process.execPath} ${scriptPath}`,
        promptLogPath,
      ),
      issueStateRefresher: vi.fn().mockResolvedValue([]),
      deliveryCommandRunner: commandRunner,
      templateReadFile: vi
        .fn()
        .mockResolvedValue(`Linear Issue: <!-- OWN-123 -->`),
      linearFetchFn: mockLinearCommentFetch(),
    });

    await expect(
      runner.runAttempt({
        issue: makeIssue({
          id: "issue-1",
          identifier: "OWN-28",
          title: "Add new files",
          branchName: "terosuhonen/own-28-add-new-files",
          url: "https://linear.app/demo/issue/OWN-28",
          state: "In Progress",
        }),
        attempt: null,
      }),
    ).rejects.toThrow(
      "./scripts/verify failed with exit code 1. listen EPERM 127.0.0.1",
    );
  });
});

function validWorkflowDefinition(
  workspaceRoot: string,
  command: string,
  promptLogPath: string,
  maxTurns = 2,
): WorkflowDefinition {
  process.env.PROMPT_LOG_PATH = promptLogPath;
  return {
    config: {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_slug: "demo",
      },
      workspace: {
        root: workspaceRoot,
      },
      agent: {
        max_turns: maxTurns,
      },
      codex: {
        command,
      },
    },
    promptTemplate:
      "You are working on {{ issue.identifier }} attempt {{ attempt }} {% for comment in issue.comments %}{{ comment.body }} {% endfor %} {% if issue.githubReviewSummary %}{{ issue.githubReviewSummary }}{% endif %} {% for comment in issue.githubReviewComments %}{{ comment.body }} {% endfor %}",
  };
}

function makeIssue(
  overrides: Partial<OrchestrationIssue> = {},
): OrchestrationIssue {
  const identifier = overrides.identifier ?? "ABC-1";
  return {
    id: overrides.id ?? identifier.toLowerCase(),
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: "priority" in overrides ? (overrides.priority ?? null) : 1,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    comments: overrides.comments ?? [],
    githubReviewSummary:
      "githubReviewSummary" in overrides
        ? (overrides.githubReviewSummary ?? null)
        : null,
    githubReviewRound:
      "githubReviewRound" in overrides
        ? (overrides.githubReviewRound ?? null)
        : null,
    githubReviewUrl:
      "githubReviewUrl" in overrides
        ? (overrides.githubReviewUrl ?? null)
        : null,
    githubReviewComments: overrides.githubReviewComments ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-01T10:00:00.000Z"),
  };
}

function mockLinearCommentFetch(
  commentBody = "Implemented the requested change and validated it. PR: https://github.com/example/repo/pull/123",
) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-1",
              body: commentBody,
              url: "https://linear.app/demo/comment/comment-1",
            },
          },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  );
}
