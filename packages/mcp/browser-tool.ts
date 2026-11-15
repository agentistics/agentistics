/**
 * NAVEGADOR S1 — what `agentistics_browser_status` says. PURE: it reduces the body of
 * `GET /api/browser/status` (the browser host's own snapshot — the same source the web reads) to an
 * ALLOWLIST, never a spread, so a field the host gains later does not reach an agent by default.
 *
 * Deliberately left out: the list of paths the executable lookup TRIED (a file-system tour that helps
 * nobody decide anything), the profile folders, and every tab URL's query and fragment (kept only up to
 * its path) — a page URL can carry a token, and status is a summary, not a page read (S2's snapshot is).
 */

export interface BrowserStatusAnswer {
  executable: { found: boolean; path: string | null; kind: string | null; source: string | null; sentence: string };
  live: Array<{
    owner: string;
    phase: string;
    pid: number | null;
    viewers: number;
    idleSeconds: number | null;
    tabs: Array<{ url: string; title: string; active: boolean }>;
    memoryMB: number | null;
    memoryBasis: string | null;
    scope: boolean;
    scopeEscaped: boolean;
    sandbox: boolean;
  }>;
  ceilings: { live: number; session: number; personal: number; tabsSession: number; tabsPersonal: number } | null;
  memory: { availableMB: number | null; minAvailableMB: number | null; measured: boolean };
  scopeAvailable: boolean;
  recentStops: Array<{ owner: string; reason: string; at: string }>;
  lastSweep: { at: string; killed: number; removedDirs: number; keptForOtherHost: number } | null;
  note: string;
}

const MB = 1024 * 1024;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const mb = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.round(n / MB); };
const iso = (v: unknown): string => { const n = num(v); return n === null ? "" : new Date(n).toISOString(); };

/** `https://a.b/x?token=1#y` → `https://a.b/x`. A URL that does not parse is kept as is, cut to 200. */
export function summaryUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.host) return `${u.protocol}${u.pathname}`.slice(0, 200);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw.slice(0, 200);
  }
}

function ownerLabel(o: unknown): string {
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  if (r.kind === "personal") return "personal";
  if (r.kind === "session" && typeof r.managedId === "string") return `session:${r.managedId}`;
  return "unknown";
}

export function browserStatusTool(body: unknown, now: number = Date.now()): BrowserStatusAnswer {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const ex = (b.executable && typeof b.executable === "object" ? b.executable : {}) as Record<string, unknown>;
  const found = ex.found === true;
  const c = b.ceilings && typeof b.ceilings === "object" ? b.ceilings : null;
  return {
    executable: {
      found,
      path: found ? str(ex.path) : null,
      kind: found ? str(ex.kind) : null,
      source: found ? str(ex.source) : null,
      sentence: str(ex.sentence) ?? (found ? "" : "No browser found."),
    },
    live: (Array.isArray(b.live) ? b.live : []).map((e: any) => ({
      owner: ownerLabel(e?.owner),
      phase: str(e?.phase) ?? "unknown",
      pid: num(e?.pid),
      viewers: num(e?.viewers) ?? 0,
      idleSeconds: num(e?.lastActivityMs) === null ? null : Math.max(0, Math.round((now - e.lastActivityMs) / 1000)),
      tabs: (Array.isArray(e?.tabs) ? e.tabs : []).map((t: any) => ({
        url: summaryUrl(str(t?.url) ?? ""),
        title: (str(t?.title) ?? "").slice(0, 200),
        active: t?.active === true,
      })),
      memoryMB: mb(e?.memory?.bytes),
      memoryBasis: str(e?.memory?.basis),
      scope: e?.scope === true,
      scopeEscaped: e?.scopeEscaped === true,
      sandbox: e?.sandbox !== false,
    })),
    ceilings: c ? {
      live: num(c.live) ?? 0, session: num(c.session) ?? 0, personal: num(c.personal) ?? 0,
      tabsSession: num(c.tabsSession) ?? 0, tabsPersonal: num(c.tabsPersonal) ?? 0,
    } : null,
    memory: {
      availableMB: mb(b.memory?.available),
      minAvailableMB: mb(b.memory?.minAvailable),
      measured: b.memory?.measured === true,
    },
    scopeAvailable: b.scope?.available === true,
    recentStops: (Array.isArray(b.recentStops) ? b.recentStops : []).slice(0, 10).map((s: any) => ({
      owner: typeof s?.key === "string" ? (s.key === "personal" ? "personal" : s.key.startsWith("s-") ? `session:${s.key.slice(2)}` : s.key) : "unknown",
      reason: str(s?.reason) ?? "unknown",
      at: iso(s?.at),
    })),
    lastSweep: b.lastSweep && typeof b.lastSweep === "object" ? {
      at: iso(b.lastSweep.at),
      killed: num(b.lastSweep.killed) ?? 0,
      removedDirs: num(b.lastSweep.removedDirs) ?? 0,
      keptForOtherHost: num(b.lastSweep.keptForOtherHost) ?? 0,
    } : null,
    note: "Read-only. Memory is PSS (shared pages counted once). At most 2 session browsers + 1 personal; a new one needs 1.5 GB available. The browser actions arrive in a later release.",
  };
}

// ---------------------------------------------------------------------------------------------------
// NAVEGADOR S2 — the session's browser verbs. Each tool is ONE call to `POST /api/browser/session/<verb>`;
// every rule (validation, block list, who may drive which browser, the lock in S3) is the server's.

/** The body a session verb sends: the tool's arguments plus the pane's HMAC proof. A `session` field
 *  the caller put in the arguments is dropped — the proof is never the model's to choose. */
export function browserSessionBody(args: unknown, proof: { id: string; token: string } | undefined): Record<string, unknown> {
  const a: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  delete a.session;
  return { ...a, session: proof ?? null };
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** What the model reads back. A screenshot is an IMAGE (plus its facts as text); a snapshot is its text
 *  as is; a refusal is the server's sentence, marked as an error. */
export function browserReply(body: unknown): { content: McpContent[]; isError?: boolean } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.ok === false) {
    const sentence = typeof b.sentence === "string" ? b.sentence : "The browser refused the action.";
    return { content: [{ type: "text", text: `${sentence}${typeof b.error === "string" ? ` (${b.error})` : ""}` }], isError: true };
  }
  // S3: the padlock's own answers (an action held and handed back, a wait that ended) are a SENTENCE the
  // model acts on — not a JSON dump in which "ok: true" could read as "it was done".
  if (typeof b.sentence === "string" && (b.performed === false || typeof b.locked === "boolean")) {
    return { content: [{ type: "text", text: b.sentence }] };
  }
  if (typeof b.data === "string" && typeof b.mime === "string" && b.mime.startsWith("image/")) {
    const { data, ...rest } = b;
    return { content: [{ type: "image", data, mimeType: b.mime }, { type: "text", text: JSON.stringify(rest) }] };
  }
  if (typeof b.snapshot === "string") {
    const foot = `\n\n(refs: ${b.refs ?? 0}${b.truncated ? `, truncated — ${b.omittedRefs ?? 0} ref(s) left out` : ""}; ${b.bytes ?? 0} bytes)`;
    return { content: [{ type: "text", text: `${b.snapshot}${foot}` }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(b, null, 2) }] };
}
