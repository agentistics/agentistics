/**
 * NAVEGADOR S3 — the MCP half of the browser padlock. No rule lives here (spec §5): every tool is one
 * call to `/api/browser/*`, and who may change the padlock, how long a call is held and what it answers
 * are all the server's. What this module owns is what only the MCP process CAN do:
 *
 * - KEEP A HELD CALL ALIVE. The server may hold an action (or `wait_unlock`) while the person drives the
 *   browser, longer than some harnesses wait for a tool without news (P4: OpenCode cuts at 60 s). While
 *   the HTTP call is pending, a `notifications/progress` goes out every `PROGRESS_EVERY_MS` (≤ 20 s) when
 *   the client sent a `progressToken` — measured to reset OpenCode's timer (60 s → 100 s+).
 * - SAY WHO IS ASKING to change the padlock. `agentistics_browser_lock` is the person's tool; inside a
 *   session it sends that session's identity so the server refuses it (`session_cannot_unlock`) — and it
 *   sends one even when no proof can be computed, so a broken key never makes a session look like the
 *   person.
 */

import { ancestorSession, type ReadProc } from "./session-proof.js";

/** The MCP's tick while a browser call is pending (the server's `PROGRESS_EVERY_MS`, ≤ 20 s). */
export const PROGRESS_EVERY_MS = 15_000;

/** The browser verbs that may be HELD by the padlock — they get the progress keep-alive. */
export const HOLDABLE_BROWSER_TOOLS = new Set([
  "agentistics_browser_navigate", "agentistics_browser_back", "agentistics_browser_forward", "agentistics_browser_reload",
  "agentistics_browser_click", "agentistics_browser_type", "agentistics_browser_press", "agentistics_browser_select",
  "agentistics_browser_scroll", "agentistics_browser_evaluate", "agentistics_browser_tab_new", "agentistics_browser_tab_select",
  "agentistics_browser_tab_close", "agentistics_browser_close", "agentistics_browser_wait_unlock",
]);

export type ProgressToken = string | number;

export interface ProgressDeps {
  send: (n: { method: "notifications/progress"; params: { progressToken: ProgressToken; progress: number; message: string } }) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
  everyMs?: number;
}

/**
 * Await `work`, sending a progress notification every `everyMs` while it is pending. Without a token the
 * client asked for no progress, and nothing is sent (a notification nobody asked for is a protocol error
 * on strict clients). A failed send never fails the call.
 */
export async function withProgress<T>(token: ProgressToken | undefined, work: Promise<T>, deps: ProgressDeps): Promise<T> {
  if (token === undefined || token === null) return work;
  const every = deps.everyMs ?? PROGRESS_EVERY_MS;
  const si = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const ci = deps.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>));
  let n = 0;
  const timer = si(() => {
    n++;
    deps.send({
      method: "notifications/progress",
      params: { progressToken: token, progress: n, message: `waiting for the person to hand the browser back (${Math.round((n * every) / 1000)} s)` },
    }).catch(() => {});
  }, every);
  try {
    return await work;
  } finally {
    ci(timer);
  }
}

/** The client's progress token, if it sent one (`params._meta.progressToken`). */
export function progressTokenOf(req: { params?: { _meta?: { progressToken?: unknown } } }): ProgressToken | undefined {
  const t = req.params?._meta?.progressToken;
  return typeof t === "string" || typeof t === "number" ? t : undefined;
}

/**
 * The body of `POST /api/browser/lock`. `owner` is the session whose browser it is (a managed id).
 * `session` is WHO is asking: the pane's proof; inside a session with no computable proof, a marker the
 * server refuses all the same; outside any session, null (the person).
 */
export function browserLockBody(
  args: unknown,
  proof: { id: string; token: string } | undefined,
  env: Record<string, string | undefined>,
  readProc?: ReadProc,
): Record<string, unknown> {
  const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const inside = env.AGENTOP_MANAGED_ID || ancestorSession(readProc)?.id;
  const session = proof ?? (inside ? { id: inside, token: "" } : null);
  return { owner: a.session, lock: a.lock, session };
}
