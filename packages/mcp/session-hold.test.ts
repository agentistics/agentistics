import { describe, expect, test } from "bun:test";
import { holdAnswer } from "./session-hold.js";

const T = Date.parse("2026-11-17T14:00:00Z");

describe("agentistics_session_hold", () => {
  test("a held session: yes, since when, in the engine's own words", () => {
    const out = holdAnswer({ available: true, session: { id: "p1", hold: { state: "held", since: T, sentence: { en: "engine words", pt: "palavras" } } } }, "p1");
    expect(out).toEqual({ available: true, id: "p1", held: true, since: "2026-11-17T14:00:00.000Z", sentence: "engine words" });
  });
  test("a session nothing holds: no, and no `since`", () => {
    expect(holdAnswer({ available: true, session: { id: "p1", hold: { state: "none" } } }, "p1")).toEqual({ available: true, id: "p1", held: false });
  });
  test("an unreadable hold is null with a note, never false", () => {
    const out = holdAnswer({ available: true, session: { id: "p1", hold: { state: "unknown" } } }, "p1");
    expect(out.held).toBeNull();
    expect(String(out.note)).toContain("could not be read");
  });
  test("an engine that reports no holds says so instead of reading as 'free'", () => {
    const out = holdAnswer({ available: false }, "p1");
    expect(out.available).toBe(false);
    expect(String(out.note)).toContain("no holds");
    expect(out.held).toBeUndefined();
  });
  test("no ref is asked for in words", () => {
    expect(holdAnswer({ available: true }, "")).toMatchObject({ error: expect.stringContaining("ref") });
  });
  test("an unresolved or ambiguous reference is said", () => {
    expect(holdAnswer({ available: true, session: { error: "not-found" } }, "zz")).toMatchObject({ error: "not-found" });
    expect(holdAnswer({ available: true, session: { error: "ambiguous", matches: ["a", "b"] } }, "z")).toMatchObject({ error: "ambiguous", matches: ["a", "b"] });
  });
});
