import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SymphonyOrchestrator } from "../src/orchestrator.js";
import { createStructuredLogger } from "../src/structured-logger.js";
import type { WorkflowDefinition } from "../src/workflow-loader.js";
import type { OrchestrationIssue } from "../src/orchestration-rules.js";

describe("SymphonyOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails startup when workflow validation is not dispatchable", async () => {
    const orchestrator = new SymphonyOrchestrator({
      workflowStore: fakeWorkflowStore({
        config: {
          tracker: {
            kind: "linear"
          }
        },
        promptTemplate: "Prompt"
      }),
      tracker: fakeTracker(),
      runner: fakeRunner(),
      removeWorkspace: vi.fn(),
      logger: silentLogger()
    });

    await expect(orchestrator.start()).rejects.toThrow(/tracker.api_key is required/);
  });

  it("cleans terminal workspaces on startup and dispatches eligible issues on tick", async () => {
    const terminalIssue = makeIssue({ id: "done-1", identifier: "DONE-1", state: "Done" });
    const todoA = makeIssue({ id: "todo-2", identifier: "TODO-2", priority: 2 });
    const todoB = makeIssue({ id: "todo-1", identifier: "TODO-1", priority: 1 });
    const removeWorkspace = vi.fn().mockResolvedValue(undefined);
    const startRun = vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      promise: new Promise(() => {})
    }));

    const orchestrator = new SymphonyOrchestrator({
      workflowStore: fakeWorkflowStore(validWorkflowDefinition()),
      tracker: fakeTracker({
        fetchIssuesByStates: vi.fn().mockResolvedValue([terminalIssue]),
        fetchCandidateIssues: vi.fn().mockResolvedValue([todoA, todoB])
      }),
      runner: {
        startRun
      },
      removeWorkspace,
      logger: silentLogger()
    });

    await orchestrator.start();
    await vi.advanceTimersToNextTimerAsync();

    expect(removeWorkspace).toHaveBeenCalledTimes(1);
    expect(removeWorkspace.mock.calls[0]?.[0]).toContain("DONE-1");
    expect(startRun.mock.calls.map((call) => call[0].issue.identifier)).toEqual(["TODO-1", "TODO-2"]);
  });

  it("reconciles terminal issues by cancelling the run and cleaning the workspace", async () => {
    const cancel = vi.fn();
    const runPromise = new Promise<{ reason: "normal" }>(() => {
      // Intentionally unresolved for reconciliation coverage.
    });

    const tracker = fakeTracker({
      fetchCandidateIssues: vi.fn().mockResolvedValue([]),
      fetchIssueStatesByIds: vi.fn().mockResolvedValue([
        makeIssue({ id: "issue-1", identifier: "ABC-1", state: "Done" })
      ])
    });

    const removeWorkspace = vi.fn().mockResolvedValue(undefined);
    const orchestrator = new SymphonyOrchestrator({
      workflowStore: fakeWorkflowStore(validWorkflowDefinition()),
      tracker,
      runner: {
        startRun: vi.fn().mockReturnValue({
          cancel,
          promise: runPromise
        })
      },
      removeWorkspace,
      logger: silentLogger()
    });

    await orchestrator.start();
    await orchestrator.dispatchNow(makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }), null);
    await orchestrator.tick();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("schedules a continuation retry after a normal worker exit", async () => {
    let resolveRun: ((value: { reason: "normal" }) => void) | undefined;
    const orchestrator = new SymphonyOrchestrator({
      workflowStore: fakeWorkflowStore(validWorkflowDefinition()),
      tracker: fakeTracker({
        fetchCandidateIssues: vi.fn().mockResolvedValue([
          makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" })
        ])
      }),
      runner: {
        startRun: vi.fn().mockReturnValue({
          cancel: vi.fn(),
          promise: new Promise((resolve) => {
            resolveRun = resolve;
          })
        })
      },
      removeWorkspace: vi.fn(),
      logger: silentLogger()
    });

    await orchestrator.start();
    await orchestrator.dispatchNow(makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }), null);
    resolveRun?.({ reason: "normal" });
    await Promise.resolve();

    const snapshot = orchestrator.snapshot();
    expect(snapshot.retries).toHaveLength(1);
    expect(snapshot.retries[0]).toMatchObject({
      issueId: "issue-1",
      attempt: 1
    });
  });

  it("fires retry timers and redispatches the issue when it is still eligible", async () => {
    const startRun = vi
      .fn()
      .mockReturnValueOnce({
        cancel: vi.fn(),
        promise: Promise.resolve({ reason: "normal" })
      })
      .mockReturnValueOnce({
        cancel: vi.fn(),
        promise: Promise.resolve({ reason: "normal" })
      });

    const tracker = fakeTracker({
      fetchCandidateIssues: vi.fn().mockResolvedValue([
        makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" })
      ])
    });

    const orchestrator = new SymphonyOrchestrator({
      workflowStore: fakeWorkflowStore(validWorkflowDefinition()),
      tracker,
      runner: {
        startRun
      },
      removeWorkspace: vi.fn(),
      logger: silentLogger()
    });

    await orchestrator.start();
    await orchestrator.dispatchNow(makeIssue({ id: "issue-1", identifier: "ABC-1", state: "In Progress" }), null);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);

    expect(startRun).toHaveBeenCalledTimes(2);
  });
});

function validWorkflowDefinition(): WorkflowDefinition {
  return {
    config: {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_slug: "demo"
      },
      polling: {
        interval_ms: 30000
      },
      workspace: {
        root: "/tmp/symphony-test"
      }
    },
    promptTemplate: "Prompt {{ issue.identifier }}"
  };
}

function fakeWorkflowStore(definition: WorkflowDefinition) {
  return {
    load: vi.fn().mockResolvedValue({ current: definition }),
    current: vi.fn().mockReturnValue(definition),
    reload: vi.fn().mockResolvedValue({ ok: true, current: definition })
  };
}

function fakeTracker(overrides: Partial<ReturnType<typeof baseTracker>> = {}) {
  return {
    ...baseTracker(),
    ...overrides
  };
}

function baseTracker() {
  return {
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue([])
  };
}

function fakeRunner() {
  return {
    startRun: vi.fn().mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve({ reason: "normal" })
    })
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

function silentLogger() {
  return createStructuredLogger({
    write: () => {}
  });
}
