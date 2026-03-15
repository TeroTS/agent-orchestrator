import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerClient,
  type CodexRuntimeEvent,
} from "../../src/codex/app-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function createScenarioDir(
  name: string,
  scenario: string,
): Promise<{ dir: string; scriptPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-app-server.mjs");
  await writeFile(
    scriptPath,
    `
import readline from "node:readline";

const scenario = ${JSON.stringify(scenario)};
  const state = { turnCount: 0, experimentalApi: false };
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function sendRaw(text) {
  process.stdout.write(text);
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (typeof msg.id === "string" && msg.id.startsWith("tool-") && "result" in msg) {
    if (scenario === "dynamic-tool-response-required") {
      const result = msg.result;
      if (
        !result ||
        typeof result !== "object" ||
        !Array.isArray(result.contentItems) ||
        typeof result.success !== "boolean"
      ) {
        send({ method: "turn/failed", params: { reason: "dynamic_tool_response_invalid" } });
        return;
      }
    }
    send({ method: "notification", params: { toolResult: msg.result } });
    return;
  }

  if (msg.method === "initialize") {
    state.experimentalApi = Boolean(msg.params?.capabilities?.experimentalApi);
    if (scenario === "stderr") {
      process.stderr.write("codex boot warning\\n");
    }
    send({ id: msg.id, result: { ok: true } });
    return;
  }

  if (msg.method === "thread/start") {
    if (scenario === "linear-graphql" && (!msg.params.tools || msg.params.tools[0]?.name !== "linear_graphql")) {
      send({ method: "turn/failed", params: { reason: "tool_not_advertised" } });
      return;
    }
    if (scenario === "dynamic-tools-required") {
      if (!state.experimentalApi) {
        send({ method: "turn/failed", params: { reason: "experimental_api_not_enabled" } });
        return;
      }
      const dynamicTools = msg.params.dynamicTools;
      if (!Array.isArray(dynamicTools) || dynamicTools.length < 2) {
        send({ method: "turn/failed", params: { reason: "dynamic_tools_not_advertised" } });
        return;
      }
      const commentTool = dynamicTools.find((tool) => tool?.name === "linear_add_issue_comment");
      if (!commentTool || typeof commentTool.description !== "string" || !commentTool.inputSchema) {
        send({ method: "turn/failed", params: { reason: "comment_tool_schema_missing" } });
        return;
      }
    }
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }

  if (msg.method === "turn/start") {
    state.turnCount += 1;
    send({ id: msg.id, result: { turn: { id: "turn-" + state.turnCount } } });

    if (scenario === "complete" || scenario === "stderr") {
      send({ method: "turn/completed", params: { usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } });
      return;
    }

    if (scenario === "partial") {
      sendRaw('{"method":"notification","params":{"message":"chunked"}}');
      setTimeout(() => sendRaw("\\n"), 5);
      setTimeout(() => send({ method: "turn/completed", params: {} }), 10);
      return;
    }

    if (scenario === "approval-tool") {
      send({ id: "approval-1", method: "approval/request", params: { kind: "command" } });
      send({ id: "tool-1", method: "item/tool/call", params: { tool: "unsupported_tool", callId: "call-1", threadId: "thread-1", turnId: "turn-1", arguments: {} } });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "other-message") {
      send({ method: "item/progress", params: { step: "thinking" } });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "high-signal-events") {
      send({ method: "codex/event/task_started", params: {} });
      send({
        method: "codex/event/exec_command_begin",
        params: { command: "npm test" },
      });
      send({
        method: "codex/event/exec_command_end",
        params: { command: "npm test", exit_code: 0 },
      });
      send({
        method: "codex/event/agent_message",
        params: { message: "Implemented the requested file." },
      });
      send({ method: "codex/event/task_complete", params: {} });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "user-input") {
      send({ method: "item/tool/requestUserInput", params: { prompt: "Need help" } });
      return;
    }

    if (scenario === "hang") {
      return;
    }

    if (scenario === "linear-graphql" || scenario === "linear-graphql-status-error" || scenario === "linear-graphql-invalid-json" || scenario === "linear-graphql-errors" || scenario === "dynamic-tool-response-required") {
      send({
        id: "tool-graphql-1",
        method: "item/tool/call",
        params: {
          tool: "linear_graphql",
          callId: "call-graphql-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            query: "query Viewer { viewer { id } }"
          }
        }
      });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "linear-add-issue-comment") {
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
            body: "Implemented the fix and verified it with npm test."
          }
        }
      });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "complete-ticket-delivery") {
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
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "linear-graphql-invalid-input") {
      send({
        id: "tool-graphql-1",
        method: "item/tool/call",
        params: {
          tool: "linear_graphql",
          callId: "call-graphql-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            query: "   ",
            variables: [],
            extra: true
          }
        }
      });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }

    if (scenario === "linear-graphql-multi-operation") {
      send({
        id: "tool-graphql-1",
        method: "item/tool/call",
        params: {
          tool: "linear_graphql",
          callId: "call-graphql-1",
          threadId: "thread-1",
          turnId: "turn-1",
          arguments: {
            query: "query One { viewer { id } } query Two { viewer { id } }"
          }
        }
      });
      setTimeout(() => send({ method: "turn/completed", params: {} }), 5);
      return;
    }
  }
});
`,
    "utf8",
  );

  return { dir, scriptPath };
}

describe("CodexAppServerClient", () => {
  it("performs the startup handshake, runs a turn, and emits session metadata", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-complete",
      "complete",
    );
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
    });

    await client.start();
    const result = await client.runTurn({
      prompt: "Hello",
      title: "ABC-1: Example",
    });
    await client.stop();

    expect(result).toMatchObject({
      outcome: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1",
    });
    expect(events.map((event) => event.event)).toContain("session_started");
    expect(events.map((event) => event.event)).toContain("turn_completed");
  });

  it("buffers partial stdout lines until a newline arrives", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-partial",
      "partial",
    );
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-2: Example",
    });
    await client.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification",
        }),
      ]),
    );
  });

  it("logs app-server stderr output for debugging stuck turns", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-stderr",
      "stderr",
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      logger,
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-2A: Example",
    });
    await client.stop();

    expect(logger.warn).toHaveBeenCalledWith(
      "codex app-server stderr",
      expect.objectContaining({
        chunk: "codex boot warning",
      }),
    );
  });

  it("auto-approves approval requests and rejects unsupported tool calls without stalling", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-approval",
      "approval-tool",
    );
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-3: Example",
    });
    await client.stop();

    expect(events.map((event) => event.event)).toContain(
      "approval_auto_approved",
    );
    expect(events.map((event) => event.event)).toContain(
      "unsupported_tool_call",
    );
  });

  it("includes the raw protocol method name on other_message events", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-other-message",
      "other-message",
    );
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-3A: Example",
    });
    await client.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "other_message",
          message: "item/progress",
        }),
      ]),
    );
  });

  it("normalizes high-signal Codex protocol events for operator visibility", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-high-signal",
      "high-signal-events",
    );
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-3B: Example",
    });
    await client.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "task_started",
        }),
        expect.objectContaining({
          event: "exec_command_begin",
          message: "Running command: npm test",
          payload: expect.objectContaining({
            command: "npm test",
          }),
        }),
        expect.objectContaining({
          event: "exec_command_end",
          message: "Command finished with exit code 0: npm test",
          payload: expect.objectContaining({
            command: "npm test",
            exit_code: 0,
          }),
        }),
        expect.objectContaining({
          event: "agent_message",
          message: "Implemented the requested file.",
        }),
        expect.objectContaining({
          event: "task_complete",
        }),
      ]),
    );
  });

  it("fails immediately when the server requests user input", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-input",
      "user-input",
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
    });

    await client.start();
    await expect(
      client.runTurn({
        prompt: "Hello",
        title: "ABC-4: Example",
      }),
    ).rejects.toMatchObject({
      code: "turn_input_required",
    });
    await client.stop();
  });

  it("fails a turn when the completion timeout is reached", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-timeout",
      "hang",
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 50,
    });

    await client.start();
    await expect(
      client.runTurn({
        prompt: "Hello",
        title: "ABC-5: Example",
      }),
    ).rejects.toMatchObject({
      code: "turn_timeout",
    });
    await client.stop();
  });

  it("advertises and executes the linear_graphql dynamic tool", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-linear-tool",
      "linear-graphql",
    );
    const events: CodexRuntimeEvent[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn,
      },
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-6: Example",
    });
    await client.stop();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(events.map((event) => event.event)).toContain(
      "linear_graphql_executed",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification",
          payload: expect.objectContaining({
            toolResult: expect.objectContaining({
              success: true,
              body: {
                data: {
                  viewer: {
                    id: "viewer-1",
                  },
                },
              },
              contentItems: [
                {
                  type: "inputText",
                  text: expect.any(String),
                },
              ],
            }),
          }),
        }),
      ]),
    );
  });

  it("returns schema-compliant dynamic tool responses with content items", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-dynamic-tool-response",
      "dynamic-tool-response-required",
    );
    const events: CodexRuntimeEvent[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn,
      },
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-6B: Example",
    });
    await client.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification",
          payload: expect.objectContaining({
            toolResult: expect.objectContaining({
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text: expect.any(String),
                },
              ],
            }),
          }),
        }),
      ]),
    );
  });

  it("advertises and executes the linear_add_issue_comment tool and returns completion comment metadata", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-linear-add-comment",
      "linear-add-issue-comment",
    );
    const events: CodexRuntimeEvent[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: "comment-1",
                body: "Implemented the fix and verified it with npm test.",
                url: "https://linear.app/demo/comment/comment-1",
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn,
      },
    });

    await client.start();
    const result = await client.runTurn({
      prompt: "Hello",
      title: "ABC-6A: Example",
    });
    await client.stop();

    expect(result.completionComment).toEqual({
      id: "comment-1",
      body: "Implemented the fix and verified it with npm test.",
      url: "https://linear.app/demo/comment/comment-1",
    });
    expect(events.map((event) => event.event)).toContain(
      "linear_issue_comment_created",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification",
          payload: expect.objectContaining({
            toolResult: expect.objectContaining({
              success: true,
              comment: expect.objectContaining({
                id: "comment-1",
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it("advertises and executes the complete_ticket_delivery tool and returns delivery metadata", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-complete-ticket-delivery",
      "complete-ticket-delivery",
    );
    let prBody = "";
    const commandRunner = vi.fn(async (input) => {
      if (
        input.command === "gh" &&
        input.args[0] === "pr" &&
        input.args[1] === "create"
      ) {
        const bodyFilePath = input.args[input.args.indexOf("--body-file") + 1];
        prBody = await readFile(bodyFilePath, "utf8");
      }

      const command = `${input.command} ${input.args.join(" ")}`.trim();
      switch (command) {
        case "git branch --show-current":
          return { stdout: "feature/abc-1\n", stderr: "", exitCode: 0 };
        case "git status --porcelain":
          return { stdout: " M foo.ts\n", stderr: "", exitCode: 0 };
        case "./scripts/verify":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "git add -A":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "git commit -m ABC-1: Example":
          return {
            stdout: "[feature/abc-1 abc1234] ABC-1: Example\n",
            stderr: "",
            exitCode: 0,
          };
        case "gh repo view --json nameWithOwner -q .nameWithOwner":
          return { stdout: "example/repo\n", stderr: "", exitCode: 0 };
        case "git push -u origin HEAD":
          return { stdout: "", stderr: "", exitCode: 0 };
        case 'gh pr list --repo example/repo --head feature/abc-1 --state open --json number,url --jq if length == 1 then .[0].url elif length == 0 then "" else error("multiple open pull requests for branch") end':
          return { stdout: "", stderr: "", exitCode: 0 };
        case "gh pr create --repo example/repo --base main --head feature/abc-1 --title ABC-1: Example --body-file":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "gh pr view feature/abc-1 --repo example/repo --json url -q .url":
          return {
            stdout: "https://github.com/example/repo/pull/123\n",
            stderr: "",
            exitCode: 0,
          };
        default:
          if (
            input.command === "gh" &&
            input.args[0] === "pr" &&
            input.args[1] === "create"
          ) {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          throw new Error(`Unexpected command: ${command}`);
      }
    });
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      linearGraphql: {
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "demo",
        fetchFn: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              data: {
                commentCreate: {
                  success: true,
                  comment: {
                    id: "comment-1",
                    body: "Summary. Validation. PR: https://github.com/example/repo/pull/123",
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
        ),
      },
      issueDelivery: {
        issueId: "issue-1",
        identifier: "ABC-1",
        title: "Example",
        url: "https://linear.app/demo/issue/ABC-1",
        branchName: "feature/abc-1",
        commandRunner,
        readFileFn: vi
          .fn()
          .mockResolvedValue(
            [
              "Linear Issue: <!-- OWN-123 -->",
              "",
              "#### Context",
              "",
              "<!-- Why is this change needed? Length <= 240 chars -->",
              "",
              "#### TL;DR",
              "",
              "_<!-- A short description of what we are changing. Use simple language. Assume reader is not familiar with this code. Length <= 120 chars -->_",
              "",
              "#### Summary",
              "",
              "- <!-- Details of the changes in bullet points -->",
              "",
              "#### Alternatives",
              "",
              "- <!-- What alternatives have been considered? Why not? -->",
              "",
              "#### Test Plan",
              "",
              "- [ ] `./scripts/verify`",
              "- [ ] <!-- Additional targeted checks (list below) -->",
            ].join("\n"),
          ),
      },
    });

    await client.start();
    const result = await client.runTurn({
      prompt: "Hello",
      title: "ABC-1: Example",
    });
    await client.stop();

    expect(result.deliveryResult).toEqual({
      branch: "feature/abc-1",
      prUrl: "https://github.com/example/repo/pull/123",
      commentId: "comment-1",
      commitSha: "abc1234",
    });
    expect(
      commandRunner.mock.calls.map(([input]) => [input.command, input.args]),
    ).toEqual([
      ["git", ["branch", "--show-current"]],
      ["git", ["status", "--porcelain"]],
      ["./scripts/verify", []],
      ["git", ["add", "-A"]],
      ["git", ["commit", "-m", "ABC-1: Example"]],
      [
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      ],
      ["git", ["push", "-u", "origin", "HEAD"]],
      [
        "gh",
        [
          "pr",
          "list",
          "--repo",
          "example/repo",
          "--head",
          "feature/abc-1",
          "--state",
          "open",
          "--json",
          "number,url",
          "--jq",
          'if length == 1 then .[0].url elif length == 0 then "" else error("multiple open pull requests for branch") end',
        ],
      ],
      [
        "gh",
        [
          "pr",
          "create",
          "--repo",
          "example/repo",
          "--base",
          "main",
          "--head",
          "feature/abc-1",
          "--title",
          "ABC-1: Example",
          "--body-file",
          expect.any(String),
        ],
      ],
      [
        "gh",
        [
          "pr",
          "view",
          "feature/abc-1",
          "--repo",
          "example/repo",
          "--json",
          "url",
          "-q",
          ".url",
        ],
      ],
    ]);
    expect(prBody).toContain("Linear Issue: ABC-1");
    expect(prBody).toContain("#### Context");
    expect(prBody).toContain(
      "Implements ABC-1: Example. Ticket: https://linear.app/demo/issue/ABC-1",
    );
    expect(prBody).toContain("#### TL;DR");
    expect(prBody).toContain("Added the requested files.");
    expect(prBody).toContain("#### Summary");
    expect(prBody).toContain("- Added the requested files.");
    expect(prBody).toContain("#### Alternatives");
    expect(prBody).toContain("- None documented.");
    expect(prBody).toContain("#### Test Plan");
    expect(prBody).toContain("- [x] `./scripts/verify`");
    expect(prBody).toContain("- [x] Verified the files exist.");
  });

  it("fails complete_ticket_delivery before publishing when runtime verify fails", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-complete-ticket-delivery-verify-fail",
      "complete-ticket-delivery",
    );
    const fetchFn = vi.fn();
    const commandRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "feature/abc-1\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: " M foo.ts\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "listen EPERM 127.0.0.1",
        exitCode: 1,
      });
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      linearGraphql: {
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "demo",
        fetchFn,
      },
      issueDelivery: {
        issueId: "issue-1",
        identifier: "ABC-1",
        title: "Example",
        url: "https://linear.app/demo/issue/ABC-1",
        branchName: "feature/abc-1",
        commandRunner,
        readFileFn: vi.fn().mockResolvedValue(`Linear Issue: <!-- OWN-123 -->`),
      },
    });

    await client.start();
    await expect(
      client.runTurn({
        prompt: "Hello",
        title: "ABC-1: Example",
      }),
    ).rejects.toThrow(
      "./scripts/verify failed with exit code 1. listen EPERM 127.0.0.1",
    );
    await client.stop();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(commandRunner).toHaveBeenCalledTimes(3);
  });

  it("resolves the pull request URL from the existing PR on the edit path", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-complete-ticket-delivery-edit",
      "complete-ticket-delivery",
    );
    const existingPrUrl = "https://github.com/example/repo/pull/789";
    const commandRunner = vi.fn(async (input) => {
      const command = `${input.command} ${input.args.join(" ")}`.trim();
      switch (command) {
        case "git branch --show-current":
          return { stdout: "feature/abc-1\n", stderr: "", exitCode: 0 };
        case "git status --porcelain":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "./scripts/verify":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "gh repo view --json nameWithOwner -q .nameWithOwner":
          return { stdout: "example/repo\n", stderr: "", exitCode: 0 };
        case "git push -u origin HEAD":
          return { stdout: "", stderr: "", exitCode: 0 };
        case 'gh pr list --repo example/repo --head feature/abc-1 --state open --json number,url --jq if length == 1 then .[0].url elif length == 0 then "" else error("multiple open pull requests for branch") end':
          return { stdout: `${existingPrUrl}\n`, stderr: "", exitCode: 0 };
        case `gh pr edit ${existingPrUrl} --title ABC-1: Example --body-file`:
          return { stdout: "", stderr: "", exitCode: 0 };
        case `gh pr view feature/abc-1 --repo example/repo --json url -q .url`:
          return { stdout: `${existingPrUrl}\n`, stderr: "", exitCode: 0 };
        default:
          if (
            input.command === "gh" &&
            input.args[0] === "pr" &&
            input.args[1] === "edit"
          ) {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          throw new Error(`Unexpected command: ${command}`);
      }
    });
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      linearGraphql: {
        endpoint: "https://linear.example/graphql",
        apiKey: "token",
        projectSlug: "demo",
        fetchFn: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              data: {
                commentCreate: {
                  success: true,
                  comment: {
                    id: "comment-1",
                    body: `Summary. Validation. PR: ${existingPrUrl}`,
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
        ),
      },
      issueDelivery: {
        issueId: "issue-1",
        identifier: "ABC-1",
        title: "Example",
        url: "https://linear.app/demo/issue/ABC-1",
        branchName: "feature/abc-1",
        commandRunner,
        readFileFn: vi.fn().mockResolvedValue(`Linear Issue: <!-- OWN-123 -->`),
      },
    });

    await client.start();
    const result = await client.runTurn({
      prompt: "Hello",
      title: "ABC-1: Example",
    });
    await client.stop();

    expect(result.deliveryResult?.prUrl).toBe(existingPrUrl);
    expect(
      commandRunner.mock.calls.map(([input]) => [input.command, input.args]),
    ).toContainEqual([
      "gh",
      [
        "pr",
        "view",
        "feature/abc-1",
        "--repo",
        "example/repo",
        "--json",
        "url",
        "-q",
        ".url",
      ],
    ]);
  });

  it("opts into experimental dynamic tools and advertises input schemas on thread/start", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-dynamic-tools",
      "dynamic-tools-required",
    );
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
      },
    });

    await client.start();
    await client.stop();
  });

  it("rejects malformed linear_graphql input before making a request", async () => {
    const { dir, scriptPath } = await createScenarioDir(
      "codex-linear-invalid-input",
      "linear-graphql-invalid-input",
    );
    const events: CodexRuntimeEvent[] = [];
    const fetchFn = vi.fn();
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event),
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn,
      },
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-7: Example",
    });
    await client.stop();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification",
          payload: expect.objectContaining({
            toolResult: expect.objectContaining({
              success: false,
              error: expect.objectContaining({
                code: "linear_graphql_invalid_input",
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it("returns structured errors for multiple operations, http failures, invalid json, and graphql errors", async () => {
    const scenarios = [
      {
        name: "codex-linear-multi-op",
        scenario: "linear-graphql-multi-operation",
        fetchFn: vi.fn(),
        expectedCode: "linear_graphql_multiple_operations",
      },
      {
        name: "codex-linear-status-error",
        scenario: "linear-graphql-status-error",
        fetchFn: vi
          .fn()
          .mockResolvedValue(new Response("bad gateway", { status: 502 })),
        expectedCode: "linear_api_status",
      },
      {
        name: "codex-linear-invalid-json",
        scenario: "linear-graphql-invalid-json",
        fetchFn: vi
          .fn()
          .mockResolvedValue(new Response("not-json", { status: 200 })),
        expectedCode: "linear_graphql_invalid_json_response",
      },
      {
        name: "codex-linear-graphql-errors",
        scenario: "linear-graphql-errors",
        fetchFn: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ errors: [{ message: "broken" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
        expectedCode: "linear_graphql_errors",
      },
    ] as const;

    for (const entry of scenarios) {
      const { dir, scriptPath } = await createScenarioDir(
        entry.name,
        entry.scenario,
      );
      const events: CodexRuntimeEvent[] = [];
      const client = new CodexAppServerClient({
        command: `${process.execPath} ${scriptPath}`,
        workspacePath: dir,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspaceWrite" },
        readTimeoutMs: 500,
        turnTimeoutMs: 1000,
        onEvent: (event) => events.push(event),
        linearGraphql: {
          endpoint: "https://api.linear.app/graphql",
          apiKey: "linear-token",
          fetchFn: entry.fetchFn,
        },
      });

      await client.start();
      await client.runTurn({
        prompt: "Hello",
        title: "ABC-8: Example",
      });
      await client.stop();

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "notification",
            payload: expect.objectContaining({
              toolResult: expect.objectContaining({
                success: false,
                error: expect.objectContaining({
                  code: entry.expectedCode,
                }),
              }),
            }),
          }),
        ]),
      );
    }
  });

  it("emits debug request logs for linear_graphql tool success and failure", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const success = await createScenarioDir(
      "codex-linear-debug-success",
      "linear-graphql",
    );
    const successClient = new CodexAppServerClient({
      command: `${process.execPath} ${success.scriptPath}`,
      workspacePath: success.dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      logger,
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      },
    });

    await successClient.start();
    await successClient.runTurn({
      prompt: "Hello",
      title: "ABC-9: Example",
    });
    await successClient.stop();

    expect(logger.debug).toHaveBeenCalledWith(
      "linear graphql request",
      expect.objectContaining({
        endpoint: "https://api.linear.app/graphql",
        graphql_query: "query Viewer { viewer { id } }",
        graphql_variables: {},
        operation_name: "Viewer",
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "linear graphql request succeeded",
      expect.objectContaining({
        status: 200,
      }),
    );

    const failure = await createScenarioDir(
      "codex-linear-debug-failure",
      "linear-graphql-status-error",
    );
    const failureClient = new CodexAppServerClient({
      command: `${process.execPath} ${failure.scriptPath}`,
      workspacePath: failure.dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      logger,
      linearGraphql: {
        endpoint: "https://api.linear.app/graphql",
        apiKey: "linear-token",
        fetchFn: vi
          .fn()
          .mockResolvedValue(new Response("bad gateway", { status: 502 })),
      },
    });

    await failureClient.start();
    await failureClient.runTurn({
      prompt: "Hello",
      title: "ABC-10: Example",
    });
    await failureClient.stop();

    expect(logger.debug).toHaveBeenCalledWith(
      "linear graphql request failed",
      expect.objectContaining({
        error_code: "linear_api_status",
        response_preview: "bad gateway",
        status: 502,
      }),
    );
  });
});
