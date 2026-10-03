/**
 * The MCP analytics tools' LEGACY arithmetic — over `/api/data` (`AppData`), moved verbatim out of the
 * tool switch so the projected path (`projected-analytics.ts`) can be checked against exactly what the
 * surface emits (`surface-parity.ts`). Pure: data in, the tool's JSON value out.
 */
import { filterSessions, sessionHarness, sessionMessages, sessionTokens, statsCacheTotals, type AnySession } from "./session-tokens.js";

export function legacySummary(data: any, harness?: string): unknown {
  const unified = !harness || harness === "all";
  const sc = data.statsCache ?? {};
  // statsCache is Claude-only; its modelUsage is the whole-history fallback (see statsCacheTotals).
  const totals = statsCacheTotals(sc);

  // Aggregate from sessions (the only harness-aware source). statsCache is
  // Claude-only, so it's used as a fallback ONLY for the unified/claude view.
  const allSessions = filterSessions((data.sessions ?? []) as AnySession[], harness);
  let totalCostUSD = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  const modelTokens: Record<string, number> = {};
  const projectSessions: Record<string, number> = {};
  const activeDates = new Set<string>();
  for (const s of allSessions) {
    const { input, output, cacheRead, cacheWrite, cost } = sessionTokens(s);
    totalInput += input; totalOutput += output; totalCacheRead += cacheRead; totalCacheWrite += cacheWrite;
    totalCostUSD += cost;
    if (s.model) modelTokens[s.model] = (modelTokens[s.model] ?? 0) + input + output;
    if (s.project_path) projectSessions[s.project_path] = (projectSessions[s.project_path] ?? 0) + 1;
    if (s.start_time) activeDates.add(String(s.start_time).slice(0, 10));
  }
  const claudeFallback = unified || harness === "claude";
  const topModel =
    Object.entries(modelTokens).sort(([, a], [, b]) => b - a)[0]?.[0]
    ?? (claudeFallback ? totals.topModel ?? "—" : "—");
  const topProject = Object.entries(projectSessions).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "—";

  return {
    harness: unified ? "all" : harness,
    totalInputTokens:      totalInput    || (claudeFallback ? totals.input : 0),
    totalOutputTokens:     totalOutput   || (claudeFallback ? totals.output : 0),
    totalCacheReadTokens:  totalCacheRead  || (claudeFallback ? totals.cacheRead : 0),
    totalCacheWriteTokens: totalCacheWrite || (claudeFallback ? totals.cacheWrite : 0),
    estimatedCostUSD:      Math.round((totalCostUSD || (claudeFallback ? totals.cost : 0)) * 100) / 100,
    totalSessions: allSessions.length,
    topModel,
    topProject,
    activeDays: activeDates.size || (claudeFallback ? sc.activeDays ?? 0 : 0),
    // Streak is Claude-only (derived from statsCache); N/A for a single non-claude harness.
    currentStreak: claudeFallback ? sc.currentStreak ?? 0 : null,
  };
}

export function legacyHarnesses(data: any): unknown {
  const present = (data.harnesses ?? ["claude"]) as string[];
  const sessions = (data.sessions ?? []) as AnySession[];
  const rows = present.map((h) => {
    const hs = sessions.filter((s) => sessionHarness(s) === h);
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, messages = 0, lastActive = "";
    for (const s of hs) {
      const t = sessionTokens(s);
      input += t.input; output += t.output; cacheRead += t.cacheRead; cacheWrite += t.cacheWrite; cost += t.cost;
      messages += sessionMessages(s);
      if (s.start_time && String(s.start_time) > lastActive) lastActive = String(s.start_time);
    }
    return {
      harness: h,
      sessions: hs.length,
      messages,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      estimatedCostUSD: Math.round(cost * 100) / 100,
      lastActive: lastActive || null,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);
  return rows;
}

export function legacyProjects(data: any, harness?: string): unknown {
  // projects[] only has {name, path, sessions:[{sessionId}]} — aggregate tokens/cost from sessions
  const allSessions = filterSessions((data.sessions ?? []) as AnySession[], harness);
  const byPath: Record<string, { sessions: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUSD: number; messages: number; lastActive: string; languages: string[] }> = {};
  for (const s of allSessions) {
    const key = s.project_path as string;
    if (!key) continue;
    if (!byPath[key]) byPath[key] = { sessions: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, messages: 0, lastActive: "", languages: [] };
    const agg = byPath[key]!;
    const { input, output, cacheRead, cacheWrite, cost } = sessionTokens(s);
    agg.sessions     += 1;
    agg.inputTokens  += input;
    agg.outputTokens += output;
    agg.cacheRead    += cacheRead;
    agg.cacheWrite   += cacheWrite;
    agg.costUSD      += cost;
    agg.messages     += sessionMessages(s);
    if (!agg.lastActive || (s.start_time ?? "") > agg.lastActive) agg.lastActive = s.start_time ?? "";
    for (const lang of s.languages ?? []) if (!agg.languages.includes(lang)) agg.languages.push(lang);
  }
  const projects = (data.projects ?? []) as Array<any>;
  const summary = projects
    // When scoped to a harness, drop projects with no sessions in that harness.
    .filter((p: any) => !harness || harness === "all" || byPath[p.path])
    .map((p: any) => {
      const agg = byPath[p.path] ?? { sessions: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, messages: 0, lastActive: "", languages: [] };
      return {
        name: p.name,
        path: p.path,
        sessions: (!harness || harness === "all") ? (p.sessions ?? []).length : agg.sessions,
        messages: agg.messages,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        totalTokens: agg.inputTokens + agg.outputTokens,
        estimatedCostUSD: Math.round(agg.costUSD * 10000) / 10000,
        lastActive: agg.lastActive || null,
        languages: agg.languages,
      };
    })
    .sort((a: any, b: any) => b.totalTokens - a.totalTokens);
  return summary;
}

export function legacyCosts(data: any, harness?: string): unknown {
  // The unified/claude view uses statsCache.modelUsage (Claude-complete, incl.
  // meta-only sessions). A specific harness is aggregated per-model from its
  // sessions, since statsCache is Claude-only.
  if (!harness || harness === "all" || harness === "claude") {
    const usage = (data.statsCache?.modelUsage ?? {}) as Record<string, any>;
    const breakdown = Object.entries(usage)
      .map(([model, u]: [string, any]) => ({
        model,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        cacheWriteTokens: u.cacheWriteTokens ?? 0,
        totalTokens: u.totalTokens ?? 0,
        estimatedCostUSD: u.costUSD ?? 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return breakdown;
  }
  const byModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUSD: number }> = {};
  for (const s of filterSessions((data.sessions ?? []) as AnySession[], harness)) {
    const model = (s.model as string) || "unknown";
    if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUSD: 0 };
    const agg = byModel[model]!;
    const { input, output, cacheRead, cacheWrite, cost } = sessionTokens(s);
    agg.inputTokens += input; agg.outputTokens += output; agg.cacheReadTokens += cacheRead; agg.cacheWriteTokens += cacheWrite;
    agg.estimatedCostUSD += cost;
  }
  const breakdown = Object.entries(byModel)
    .map(([model, u]) => ({
      model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      estimatedCostUSD: Math.round(u.estimatedCostUSD * 10000) / 10000,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return breakdown;
}

export function legacyRepos(data: any, harness?: string): unknown {
  const allSessions = filterSessions((data.sessions ?? []) as AnySession[], harness);
  const byRemote: Record<string, { sessions: number; messages: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUSD: number; lastActive: string }> = {};
  for (const s of allSessions) {
    const key = (s.git_remote as string) || "";
    if (!byRemote[key]) byRemote[key] = { sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, lastActive: "" };
    const agg = byRemote[key]!;
    const { input, output, cacheRead, cacheWrite, cost } = sessionTokens(s);
    agg.sessions += 1;
    agg.messages += sessionMessages(s);
    agg.inputTokens += input; agg.outputTokens += output; agg.cacheRead += cacheRead; agg.cacheWrite += cacheWrite;
    agg.costUSD += cost;
    if (s.start_time && String(s.start_time) > agg.lastActive) agg.lastActive = String(s.start_time);
  }
  const rows = Object.entries(byRemote)
    .map(([remote, agg]) => ({
      repo: remote || "unlinked",
      remote: remote || null,
      sessions: agg.sessions,
      messages: agg.messages,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.inputTokens + agg.outputTokens + agg.cacheRead + agg.cacheWrite,
      estimatedCostUSD: Math.round(agg.costUSD * 10000) / 10000,
      lastActive: agg.lastActive || null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return rows;
}
