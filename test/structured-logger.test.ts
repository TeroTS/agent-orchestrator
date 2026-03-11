import { describe, expect, it } from "vitest";

import { createStructuredLogger } from "../src/structured-logger.js";

describe("createStructuredLogger", () => {
  it("formats stable key=value logs with issue and session context", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      write: (line) => lines.push(line)
    });

    logger.info("dispatch completed", {
      issue_id: "issue-1",
      issue_identifier: "ABC-1",
      session_id: "thread-1-turn-1",
      outcome: "completed"
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("level=info");
    expect(lines[0]).toContain('msg="dispatch completed"');
    expect(lines[0]).toContain("issue_id=issue-1");
    expect(lines[0]).toContain("issue_identifier=ABC-1");
    expect(lines[0]).toContain("session_id=thread-1-turn-1");
    expect(lines[0]).toContain("outcome=completed");
  });
});
