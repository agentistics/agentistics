import { describe, expect, test } from "bun:test";
import { callAnswer } from "./session-call.js";

const T = Date.parse("2026-11-17T14:00:00.000Z");

describe("agentistics_session_call", () => {
  test("a session in a call: yes, since when", () => {
    const out = callAnswer({ voice: true, calls: [], session: { id: "p1", call: { callId: "c1", sessionId: "p1", startedAt: T } } }, "p1");
    expect(out).toEqual({ voice: true, id: "p1", inCall: true, since: "2026-11-17T14:00:00.000Z", callId: "c1" });
  });
  test("a session not in a call: no, and no `since`", () => {
    expect(callAnswer({ voice: true, calls: [], session: { id: "p1", call: null } }, "p1")).toEqual({ voice: true, id: "p1", inCall: false });
  });
  test("a build without voice says so instead of reading as an empty line", () => {
    const out = callAnswer({ voice: false, calls: [], session: { id: "p1", call: null } }, "p1");
    expect(out.inCall).toBe(false);
    expect(String(out.note)).toContain("no voice");
  });
  test("no ref lists every live call", () => {
    const out = callAnswer({ voice: true, calls: [{ callId: "c1", sessionId: "p1", startedAt: T }] }, "");
    expect(out).toEqual({ voice: true, calls: [{ sessionId: "p1", callId: "c1", since: "2026-11-17T14:00:00.000Z" }] });
  });
  test("an unknown or ambiguous reference is an error, never `inCall: false`", () => {
    expect(callAnswer({ voice: true, calls: [], session: { error: "not-found" } }, "zz")).toMatchObject({ error: "not-found" });
    expect(callAnswer({ voice: true, calls: [], session: { error: "ambiguous", matches: ["a", "b"] } }, "z")).toMatchObject({ error: "ambiguous", matches: ["a", "b"] });
  });
});
