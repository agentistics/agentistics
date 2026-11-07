import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryCalendarQuery } from "./delivery-calendar-args";

describe("agentistics_delivery_calendar", () => {
  test("no filters is the bare route", () => { expect(deliveryCalendarQuery(undefined)).toBe(""); });
  test("each filter maps to its query parameter; lists become comma lists", () => {
    expect(deliveryCalendarQuery({
      task: " Esteira ", subtask: "s-1", version: ["2.202.0", "2.203.0"], stage: "qa,running", harness: ["codex"],
      priority: "high", from: "2026-11-07", to: "2026-11-09", all: true, confirmedOnly: true, format: "ics",
    })).toBe("?task=Esteira&subtask=s-1&version=2.202.0%2C2.203.0&stage=qa%2Crunning&harness=codex&priority=high&from=2026-11-07&to=2026-11-09&all=1&confirmed=1&format=ics");
  });
  test("an unknown stage or priority is dropped, not forwarded", () => {
    expect(deliveryCalendarQuery({ stage: "nonsense", priority: ["x"] })).toBe("");
    expect(deliveryCalendarQuery({ all: "yes", format: "xml" })).toBe("");
  });
  test("the tool is declared, read-only, and admits a missing estimate", () => {
    const src = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
    const at = src.indexOf('name: "agentistics_delivery_calendar"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 3000);
    expect(block).toContain("never invent a time");
    expect(block).toContain("BETA");
    expect(src).toContain("deliveryCalendarQuery(args as any)");
  });
});
