import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type CodexRuntimeEvent
} from "../src/codex-app-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createScenarioDir(name: string, scenario: string): Promise<{ dir: string; scriptPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-app-server.mjs");
  await writeFile(
    scriptPath,
    `
import readline from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const state = { turnCount: 0 };
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function sendRaw(text) {
  process.stdout.write(text);
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
    state.turnCount += 1;
    send({ id: msg.id, result: { turn: { id: "turn-" + state.turnCount } } });

    if (scenario === "complete") {
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
      send({ id: "tool-1", method: "item/tool/call", params: { name: "unsupported_tool", arguments: {} } });
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
  }
});
`,
    "utf8"
  );

  return { dir, scriptPath };
}

describe("CodexAppServerClient", () => {
  it("performs the startup handshake, runs a turn, and emits session metadata", async () => {
    const { dir, scriptPath } = await createScenarioDir("codex-complete", "complete");
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event)
    });

    await client.start();
    const result = await client.runTurn({
      prompt: "Hello",
      title: "ABC-1: Example"
    });
    await client.stop();

    expect(result).toMatchObject({
      outcome: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1"
    });
    expect(events.map((event) => event.event)).toContain("session_started");
    expect(events.map((event) => event.event)).toContain("turn_completed");
  });

  it("buffers partial stdout lines until a newline arrives", async () => {
    const { dir, scriptPath } = await createScenarioDir("codex-partial", "partial");
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event)
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-2: Example"
    });
    await client.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "notification"
        })
      ])
    );
  });

  it("auto-approves approval requests and rejects unsupported tool calls without stalling", async () => {
    const { dir, scriptPath } = await createScenarioDir("codex-approval", "approval-tool");
    const events: CodexRuntimeEvent[] = [];
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000,
      onEvent: (event) => events.push(event)
    });

    await client.start();
    await client.runTurn({
      prompt: "Hello",
      title: "ABC-3: Example"
    });
    await client.stop();

    expect(events.map((event) => event.event)).toContain("approval_auto_approved");
    expect(events.map((event) => event.event)).toContain("unsupported_tool_call");
  });

  it("fails immediately when the server requests user input", async () => {
    const { dir, scriptPath } = await createScenarioDir("codex-input", "user-input");
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 1000
    });

    await client.start();
    await expect(
      client.runTurn({
        prompt: "Hello",
        title: "ABC-4: Example"
      })
    ).rejects.toMatchObject({
      code: "turn_input_required"
    });
    await client.stop();
  });

  it("fails a turn when the completion timeout is reached", async () => {
    const { dir, scriptPath } = await createScenarioDir("codex-timeout", "hang");
    const client = new CodexAppServerClient({
      command: `${process.execPath} ${scriptPath}`,
      workspacePath: dir,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite" },
      readTimeoutMs: 500,
      turnTimeoutMs: 50
    });

    await client.start();
    await expect(
      client.runTurn({
        prompt: "Hello",
        title: "ABC-5: Example"
      })
    ).rejects.toMatchObject({
      code: "turn_timeout"
    });
    await client.stop();
  });
});
