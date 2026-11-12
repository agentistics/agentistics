import { describe, expect, test } from "bun:test";
import { bookTakeoverPayload } from "./book-takeover-payload";

describe("book takeover MCP payload", () => {
  test("attaches the caller proof and ignores forged proof/session ids in arguments", () => {
    const payload = bookTakeoverPayload({
      taskId: "task-1",
      bookmarkHash: "bookmark-1",
      lastDeltaHash: "delta-1",
      sessionId: "foreign-session",
      session: { id: "foreign-session", token: "forged" },
    }, { id: "caller-session", token: "caller-token" });

    expect(payload).toEqual({
      taskId: "task-1",
      bookmarkHash: "bookmark-1",
      lastDeltaHash: "delta-1",
      session: { id: "caller-session", token: "caller-token" },
    });
    expect(payload.session).not.toEqual({ id: "foreign-session", token: "forged" });
    expect(payload.sessionId).toBeUndefined();
  });
});
