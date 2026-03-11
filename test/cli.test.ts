import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/app/cli.js";

describe("runCli", () => {
  it("uses ./WORKFLOW.md when no positional workflow path is provided", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const createService = vi.fn().mockResolvedValue({ start, stop });

    const exitCode = await runCli([], {
      cwd: "/repo",
      createService,
    });

    expect(exitCode).toBe(0);
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: "/repo/WORKFLOW.md",
      }),
    );
  });

  it("uses an explicit workflow path when provided", async () => {
    const createService = vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const exitCode = await runCli(["/tmp/custom-workflow.md"], {
      cwd: "/repo",
      createService,
    });

    expect(exitCode).toBe(0);
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: "/tmp/custom-workflow.md",
      }),
    );
  });

  it("parses --port and passes it to service creation", async () => {
    const createService = vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const exitCode = await runCli(
      ["--port", "4010", "/tmp/custom-workflow.md"],
      {
        cwd: "/repo",
        createService,
      },
    );

    expect(exitCode).toBe(0);
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: "/tmp/custom-workflow.md",
        port: 4010,
      }),
    );
  });

  it("returns a nonzero code when startup fails", async () => {
    const createService = vi.fn().mockResolvedValue({
      start: vi.fn().mockRejectedValue(new Error("boom")),
      stop: vi.fn().mockResolvedValue(undefined),
    });
    const stderr = vi.fn();

    const exitCode = await runCli([], {
      cwd: "/repo",
      createService,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalled();
  });

  it("returns a nonzero code when --port is invalid", async () => {
    const stderr = vi.fn();

    const exitCode = await runCli(["--port", "abc"], {
      cwd: "/repo",
      createService: vi.fn(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("invalid --port"),
    );
  });
});
