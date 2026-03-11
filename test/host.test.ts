import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runHost } from "../src/host.js";

describe("runHost", () => {
  it("stops the service on SIGTERM and exits cleanly", async () => {
    const signals = new EventEmitter();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const createService = vi.fn().mockResolvedValue({ start, stop });

    const exitPromise = runHost([], {
      cwd: "/repo",
      createService,
      signals,
    });

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    signals.emit("SIGTERM");

    await expect(exitPromise).resolves.toBe(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("returns nonzero when shutdown fails after a signal", async () => {
    const signals = new EventEmitter();
    const stderr = vi.fn();
    const start = vi.fn().mockResolvedValue(undefined);
    const createService = vi.fn().mockResolvedValue({
      start,
      stop: vi.fn().mockRejectedValue(new Error("stop failed")),
    });

    const exitPromise = runHost([], {
      cwd: "/repo",
      createService,
      stderr,
      signals,
    });

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    signals.emit("SIGINT");

    await expect(exitPromise).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("shutdown_failed stop failed");
  });
});
