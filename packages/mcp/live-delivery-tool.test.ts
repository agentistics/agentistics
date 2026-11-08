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
  test("the screen's tab, the Publicado period and the sort map to query parameters", () => {
    expect(liveDeliveryQuery({ tab: "active", period: "7d", sort: "priority" })).toBe("?tab=active&period=7d&sort=priority");
    expect(liveDeliveryQuery({ tab: "published", period: "all", sort: "recent" })).toBe("?tab=published&period=all&sort=recent");
    expect(liveDeliveryQuery({ sort: "time-in-stage" })).toBe("?sort=time-in-stage");
    expect(liveDeliveryQuery({ sort: "newest" })).toBe("");
    expect(liveDeliveryQuery({ tab: "history", period: "1y" })).toBe("");
  });
  test("the tool documents the tabs, the period, the counts, the sort and the priority field", () => {
    const src = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
    const block = src.slice(src.indexOf('name: "agentistics_live_delivery"'), src.indexOf('name: "agentistics_task_edit"'));
    for (const word of ["tab", "period", "counts", "Em andamento", "Publicado", "sort", "priority"]) expect(block).toContain(word);
    expect(block).not.toContain("onlyActive");
  });
  test("an unknown stage is dropped rather than forwarded", () => {
    expect(liveDeliveryQuery({ stage: "nonsense" })).toBe("");
    expect(liveDeliveryQuery({ stalledOnly: "yes" })).toBe("");
  });
  test("the tool is declared, read-only, and says to admit a missing estimate", () => {
    const src = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
    const at = src.indexOf('name: "agentistics_live_delivery"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 3200);
    expect(block).toContain("never invent a time");
    expect(block).toContain("leaders");
    expect(block).toContain("stepSource");
    expect(block).toContain("stepSignal");
    expect(block).not.toContain("BETA");
    expect(src).toContain("liveDeliveryQuery(args as any)");
  });
});
