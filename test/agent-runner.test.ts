import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunner } from "../src/agent-runner.js";
import type { WorkflowDefinition } from "../src/workflow-loader.js";
import type { OrchestrationIssue } from "../src/orchestration-rules.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("AgentRunner", () => {
  it("creates a workspace, runs a turn, refreshes tracker state, and stops when the issue becomes terminal", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runner-workspace-"));
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
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8"
    );

    const tracker = {
      fetchIssueStatesByIds: vi
        .fn()
        .mockResolvedValueOnce([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" })
        ])
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(workspaceRoot, `${process.execPath} ${scriptPath}`, promptLogPath),
      issueStateRefresher: tracker.fetchIssueStatesByIds
    });

    const result = await runner.runAttempt({
      issue: makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
      attempt: null
    });

    expect(result).toEqual({ reason: "normal" });
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledWith(["issue-1"]);
    const prompts = (await readFile(promptLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(prompts[0]).toContain("ABC-1");
  });

  it("runs continuation turns while the issue remains active and max_turns is not exhausted", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runner-workspace-"));
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
    send({ method: "turn/completed", params: {} });
  }
});
`,
      "utf8"
    );

    const tracker = {
      fetchIssueStatesByIds: vi
        .fn()
        .mockResolvedValueOnce([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" })
        ])
        .mockResolvedValueOnce([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" })
        ])
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(workspaceRoot, `${process.execPath} ${scriptPath}`, promptLogPath, 3),
      issueStateRefresher: tracker.fetchIssueStatesByIds
    });

    const result = await runner.runAttempt({
      issue: makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
      attempt: 1
    });

    expect(result).toEqual({ reason: "normal" });
    const prompts = (await readFile(promptLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(prompts).toHaveLength(2);
  });

  it("logs run attempt lifecycle events", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runner-workspace-"));
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
      "utf8"
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const runner = new AgentRunner({
      workflowDefinition: validWorkflowDefinition(workspaceRoot, `${process.execPath} ${scriptPath}`, promptLogPath),
      issueStateRefresher: vi.fn().mockResolvedValue([
        makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" })
      ]),
      logger
    });

    await runner.runAttempt({
      issue: makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }),
      attempt: null
    });

    expect(logger.info).toHaveBeenCalledWith(
      "run attempt started",
      expect.objectContaining({
        issue_id: "issue-1",
        issue_identifier: "ABC-1"
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "run attempt completed",
      expect.objectContaining({
        issue_id: "issue-1",
        issue_identifier: "ABC-1"
      })
    );
  });
});

function validWorkflowDefinition(
  workspaceRoot: string,
  command: string,
  promptLogPath: string,
  maxTurns = 2
): WorkflowDefinition {
  process.env.PROMPT_LOG_PATH = promptLogPath;
  return {
    config: {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_slug: "demo"
      },
      workspace: {
        root: workspaceRoot
      },
      agent: {
        max_turns: maxTurns
      },
      codex: {
        command
      }
    },
    promptTemplate: "You are working on {{ issue.identifier }} attempt {{ attempt }}"
  };
}

function makeIssue(overrides: Partial<OrchestrationIssue> = {}): OrchestrationIssue {
  const identifier = overrides.identifier ?? "ABC-1";
  return {
    id: overrides.id ?? identifier.toLowerCase(),
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    description: overrides.description ?? null,
    priority: "priority" in overrides ? overrides.priority ?? null : 1,
    state: overrides.state ?? "Todo",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-01T10:00:00.000Z")
  };
}
