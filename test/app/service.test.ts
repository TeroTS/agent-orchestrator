import { describe, expect, it, vi } from "vitest";

import { createService } from "../../src/app/service.js";
import { createStructuredLogger } from "../../src/observability/structured-logger.js";
import type { WorkflowDefinition } from "../../src/workflow/loader.js";

describe("createService", () => {
  it("rebinds the status server when workflow reload changes the port", async () => {
    const firstDefinition: WorkflowDefinition = {
      config: {
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "demo",
        },
        server: {
          port: 3001,
        },
      },
      promptTemplate: "Prompt",
    };
    const secondDefinition: WorkflowDefinition = {
      ...firstDefinition,
      config: {
        ...firstDefinition.config,
        server: {
          port: 3002,
        },
      },
    };

    let currentDefinition = firstDefinition;
    let watchListener: (() => void | Promise<void>) | null = null;
    const stopA = vi.fn().mockResolvedValue(undefined);
    const stopB = vi.fn().mockResolvedValue(undefined);
    const startStatusServerFn = vi
      .fn()
      .mockResolvedValueOnce({ baseUrl: "http://127.0.0.1:3001", stop: stopA })
      .mockResolvedValueOnce({ baseUrl: "http://127.0.0.1:3002", stop: stopB });

    const service = await createService({
      workflowPath: "/tmp/WORKFLOW.md",
      workflowStore: {
        load: vi
          .fn()
          .mockImplementation(async () => ({ current: currentDefinition })),
        current: vi.fn().mockImplementation(() => currentDefinition),
        reload: vi.fn().mockImplementation(async () => ({
          ok: true,
          current: currentDefinition,
        })),
      },
      tracker: {
        fetchCandidateIssues: vi.fn().mockResolvedValue([]),
        fetchIssuesByStates: vi.fn().mockResolvedValue([]),
        fetchIssueStatesByIds: vi.fn().mockResolvedValue([]),
      },
      runner: {
        startRun: vi.fn(),
      },
      startStatusServerFn,
      logger: createStructuredLogger({
        write: () => {},
      }),
      watchFactory: (_path, listener) => {
        watchListener = listener;
        return { close: vi.fn() };
      },
    });

    await service.start();
    currentDefinition = secondDefinition;
    if (!watchListener) {
      throw new Error("expected watch listener");
    }
    const listener = watchListener as () => void | Promise<void>;
    await listener();

    expect(startStatusServerFn).toHaveBeenCalledTimes(2);
    expect(stopA).toHaveBeenCalledTimes(1);

    await service.stop();
    expect(stopB).toHaveBeenCalledTimes(1);
  });
});
