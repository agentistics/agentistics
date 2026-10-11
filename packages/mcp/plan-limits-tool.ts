import { routeRecommendation, type RouteKind } from "@agentistics/core";

/** The `agentistics_plan_limits` handler, split out so it can be exercised without the stdio server. */
export function planLimitsTool(
  args: { kind?: RouteKind; authorHarness?: string } | undefined,
  /** The `GET /api/plan-limits` body (fetched by the caller so the policy lint sees the route). */
  body: { budgets?: any[]; now?: number },
) {
  const budgets = body.budgets ?? [];
  const recommendation = args?.kind ? routeRecommendation(budgets, args.kind, args.authorHarness) : undefined;
  return { budgets, ...(recommendation ? { recommendation } : {}), readAt: body.now ?? Date.now() };
}
