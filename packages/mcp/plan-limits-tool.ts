import { harnessAggregate, routeRecommendation, type RouteKind } from "@agentistics/core";

/** A label is a display name, never an address: nothing with an `@` reaches an agent. */
const plainLabel = (v: unknown): string | undefined => typeof v === "string" ? v.replace(/@/g, "") : undefined;

/** The `agentistics_plan_limits` handler, split out so it can be exercised without the stdio server. */
export function planLimitsTool(
  args: { kind?: RouteKind; authorHarness?: string } | undefined,
  /** The `GET /api/plan-limits` body (fetched by the caller so the policy lint sees the route). */
  body: { harnesses?: Record<string, { spawnable: boolean; unavailableReason?: string }>; budgets?: any[]; unmeasured?: { harness: string; account: string; status: 'hold'; reason: string }[]; freeSlots?: number; freeSlotsByHarness?: Record<string, number>; freeSlotsByAccount?: Record<string, number>; liveSessions?: any[]; pauseUntil?: number; now?: number; hiddenFromAgents?: any[] },
) {
  // Only the agent-visible rows reach this point; `limits`, owner labels and `hiddenFromAgents` stay behind.
  const budgets = (body.budgets ?? []).map(b => {
    const { accountLabel, ...rest } = b;
    const label = plainLabel(accountLabel);
    return label !== undefined ? { ...rest, accountLabel: label } : rest;
  });
  const routed = args?.kind ? routeRecommendation(budgets, args.kind, args.authorHarness) : undefined;
  const recommendation = routed?.accountLabel !== undefined ? { ...routed, accountLabel: plainLabel(routed.accountLabel) } : routed;
  const aggregates = harnessAggregate(budgets);
  const offBySchedule = (body.hiddenFromAgents ?? []).filter(b => b?.agentUse && !b.agentUse.on)
    .map(b => ({ harness: b.harness, account: b.account, reason: b.agentUse.reason as string }));
  return {
    budgets,
    unmeasured: body.unmeasured ?? [],
    harnesses: body.harnesses ?? {},
    freeSlots: body.freeSlots ?? (budgets.length ? Math.max(...aggregates.map(b => b.freeSlots)) : 0),
    freeSlotsByHarness: body.freeSlotsByHarness ?? Object.fromEntries(aggregates.map(b => [b.harness, b.freeSlots])),
    freeSlotsByAccount: body.freeSlotsByAccount ?? Object.fromEntries(budgets.filter(b => b.account).map(b => [b.account, b.freeSlots ?? 0])),
    liveSessions: body.liveSessions ?? budgets.flatMap(b => b.liveSessions ?? []).filter((s, i, all) => all.findIndex(x => x.id === s.id) === i),
    ...(body.pauseUntil !== undefined ? { pauseUntil: body.pauseUntil } : {}),
    // Accounts the owner's schedule keeps off right now: the id and the reason only, never a label.
    ...(offBySchedule.length ? { offBySchedule } : {}),
    ...(recommendation ? { recommendation } : {}),
    readAt: body.now ?? Date.now(),
  };
}
