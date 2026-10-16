import { routeRecommendation, type RouteKind } from "@agentistics/core";

/** The `agentistics_plan_limits` handler, split out so it can be exercised without the stdio server. */
export function planLimitsTool(
  args: { kind?: RouteKind; authorHarness?: string } | undefined,
  /** The `GET /api/plan-limits` body (fetched by the caller so the policy lint sees the route). */
  body: { harnesses?: Record<string, { spawnable: boolean; unavailableReason?: string }>; budgets?: any[]; freeSlots?: number; freeSlotsByHarness?: Record<string, number>; liveSessions?: any[]; pauseUntil?: number; now?: number },
) {
  const budgets = body.budgets ?? [];
  const recommendation = args?.kind ? routeRecommendation(budgets, args.kind, args.authorHarness) : undefined;
  return {
    budgets,
    harnesses: body.harnesses ?? {},
    freeSlots: body.freeSlots ?? (budgets.length ? Math.max(...budgets.map(b => b.freeSlots ?? 0)) : 0),
    freeSlotsByHarness: body.freeSlotsByHarness ?? Object.fromEntries(budgets.map(b => [b.harness, b.freeSlots ?? 0])),
    liveSessions: body.liveSessions ?? budgets.flatMap(b => b.liveSessions ?? []).filter((s, i, all) => all.findIndex(x => x.id === s.id) === i),
    ...(body.pauseUntil !== undefined ? { pauseUntil: body.pauseUntil } : {}),
    ...(recommendation ? { recommendation } : {}),
    readAt: body.now ?? Date.now(),
  };
}
