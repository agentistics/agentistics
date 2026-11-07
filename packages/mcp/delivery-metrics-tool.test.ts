import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryMetricsQuery } from "./delivery-metrics-args";

describe("agentistics_delivery_metrics", () => {
  test("no filters is the bare route", () => { expect(deliveryMetricsQuery(undefined)).toBe(""); });

  test("each filter maps to its query parameter; lists become comma lists", () => {
    expect(deliveryMetricsQuery({
      from: "2026-11-01", to: "2026-11-07", harness: ["claude", "codex"], version: "2.202.0,none", stage: "qa,running",
      model: ["claude-opus-5"], qa: "rejected_once", priority: ["high"], task: " Esteira ", groupBy: "version",
    })).toBe("?from=2026-11-01&to=2026-11-07&harness=claude%2Ccodex&version=2.202.0%2Cnone&stage=qa%2Crunning&model=claude-opus-5&qa=rejected_once&priority=high&task=Esteira&groupBy=version");
  });

  test("an unknown stage, QA result, priority or group-by is dropped, not forwarded", () => {
    expect(deliveryMetricsQuery({ stage: "nonsense", qa: ["x"], priority: "nope", groupBy: "year" })).toBe("");
    expect(deliveryMetricsQuery({ from: 5, task: "  " })).toBe("");
  });

  test("the query is exactly what the route and the CLI read (one contract)", async () => {
    const { metricFiltersOf } = await import("../server/server/delivery/metrics");
    const q = deliveryMetricsQuery({ from: "2026-11-01", qa: "pending", groupBy: "model", model: "none" });
    expect(metricFiltersOf(new URLSearchParams(q.slice(1)))).toMatchObject({ qa: ["pending"], groupBy: "model", authorModels: ["__none__"] });
  });

  test("the tool is declared, read-only, wired to the metrics route, and says a missing figure is not zero", () => {
    const src = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
    const at = src.indexOf('name: "agentistics_delivery_metrics"');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 4000);
    expect(block).toContain("NOTHING IS INVENTED");
    expect(block).toContain("BETA");
    expect(src).toContain("/api/deliveries/metrics${deliveryMetricsQuery(args as any)}");
    const policy = readFileSync(join(import.meta.dir, "..", "core", "src", "agentToolPolicy.ts"), "utf8");
    expect(policy).toContain("agentistics_delivery_metrics: { ...TASKS, risk: 'R', routes: ['GET /api/deliveries/metrics']");
  });
});
