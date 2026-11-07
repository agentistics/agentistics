import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveDeliveryQuery } from "./live-delivery-args";

describe("agentistics_live_delivery", () => {
  test("no filters is the bare route; each filter maps to its query parameter", () => {
    expect(liveDeliveryQuery(undefined)).toBe("");
    expect(liveDeliveryQuery({ task: " Live Delivery ", stage: "qa", stalledOnly: true }))
      .toBe("?task=Live+Delivery&stage=qa&stalled=1");
  });
  test("an unknown stage is dropped rather than forwarded", () => {
    expect(liveDeliveryQuery({ stage: "nonsense" })).toBe("");
    expect(liveDeliveryQuery({ stalledOnly: "yes" })).toBe("");
  });
  test("the tool is declared, read-only, and says to admit a missing estimate", () => {
    const src = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
    const at = src.indexOf('name: "agentistics_live_delivery"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('name: "', at + 10));
    expect(block).toContain("never invent a time");
    expect(block).toContain("leaders");
    expect(block).not.toContain("BETA");
    expect(src).toContain("liveDeliveryQuery(args as any)");
  });
});
