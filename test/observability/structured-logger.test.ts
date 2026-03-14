import { describe, expect, it } from "vitest";

import {
  createStructuredLogger,
  resolveStructuredLogLevel,
} from "../../src/observability/structured-logger.js";

describe("createStructuredLogger", () => {
  it("formats stable key=value logs with issue and session context", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line),
    });

    logger.info("dispatch completed", {
      issue_id: "issue-1",
      issue_identifier: "ABC-1",
      session_id: "thread-1-turn-1",
      outcome: "completed",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("level=info");
    expect(lines[0]).toContain('msg="dispatch completed"');
    expect(lines[0]).toContain("issue_id=issue-1");
    expect(lines[0]).toContain("issue_identifier=ABC-1");
    expect(lines[0]).toContain("session_id=thread-1-turn-1");
    expect(lines[0]).toContain("outcome=completed");
  });

  it("isolates sink write failures and falls back without throwing", () => {
    const fallbackLines: string[] = [];
    const logger = createStructuredLogger({
      write: () => {
        throw new Error("sink exploded");
      },
      fallbackWrite: (line) => fallbackLines.push(line),
    });

    expect(() =>
      logger.error("dispatch failed", {
        issue_id: "issue-1",
      }),
    ).not.toThrow();

    expect(fallbackLines).toHaveLength(1);
    expect(fallbackLines[0]).toContain('msg="log sink failure"');
    expect(fallbackLines[0]).toContain('reason="sink exploded"');
  });

  it("honors the configured minimum log level", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      level: "warn",
      write: (line) => lines.push(line),
    });

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("level=warn");
    expect(lines[1]).toContain("level=error");
  });
});

describe("resolveStructuredLogLevel", () => {
  it("normalizes valid values and falls back to info", () => {
    expect(resolveStructuredLogLevel("DEBUG")).toBe("debug");
    expect(resolveStructuredLogLevel(" warn ")).toBe("warn");
    expect(resolveStructuredLogLevel("invalid")).toBe("info");
    expect(resolveStructuredLogLevel(undefined)).toBe("info");
  });
});
