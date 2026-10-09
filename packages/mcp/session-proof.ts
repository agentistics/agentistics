/**
 * session-proof.ts — the agentistics MCP proving which agentop session it runs inside.
 *
 * agentop puts `AGENTOP_MANAGED_ID` into every pane it spawns; the proof is
 * `HMAC-SHA256(key, "agentop-session:" + id)` over the 32-byte key in `session-identity.key` (0600,
 * the agentop data dir). It is computed HERE, from the file, so no token ever travels on a command
 * line. The server's `session-identity.ts` recomputes it — `session-proof.test.ts` and the server's
 * test pin the same vector, so the two cannot drift apart unnoticed.
 *
 * No id, no key, an unreadable file: no proof, and the comment simply posts unverified.
 *
 * WHERE THE ID COMES FROM. The MCP's own environment first — but NOT only: a harness decides what its
 * MCP children inherit, and Codex hands them an allowlist (measured with codex 0.161.0: `HOME LANG
 * LC_ALL LOGNAME PATH SHELL TERM USER` plus the `[mcp_servers.*.env]` table), so `AGENTOP_MANAGED_ID`
 * (and a relocated `AGENTISTICS_DIR`) never arrived and every message from a Codex session was refused
 * as `unverified_sender`. The pane's processes still carry both, so when the environment lacks the id
 * the MCP reads it from its nearest ANCESTOR (`/proc/<pid>/environ`, the harness itself — the same
 * user's own process, readable exactly as the key file is). This asks the harness for nothing and
 * changes no registration; the proof is still the HMAC over the key file, so it is no weaker: it only
 * finds the id the environment would have carried. Off Linux there is no `/proc` and the ancestor read
 * is simply absent — the environment route is unchanged.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function sessionProofToken(key: Uint8Array, id: string): string {
  return createHmac("sha256", key).update(`agentop-session:${id}`).digest("hex");
}

/** Reads a /proc file as text, or undefined when it cannot be read (gone, not Linux, not ours). */
export type ReadProc = (path: string) => string | undefined;

const defaultReadProc: ReadProc = path => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

const MAX_ANCESTORS = 16;

/** Pure: the value of `name` in a NUL-separated `environ` blob. */
export function environValue(environ: string, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length) || undefined;
  }
  return undefined;
}

/**
 * The nearest ancestor process whose environment names a session, with the data dir it carries.
 * Walks `PPid` upward from `startPid`; stops at pid 1, a loop, an unreadable process or the depth cap.
 */
export function ancestorSession(
  readProc: ReadProc = defaultReadProc,
  startPid: number = process.ppid,
): { id: string; dir?: string } | undefined {
  const seen = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTORS && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const environ = readProc(`/proc/${pid}/environ`);
    const id = environ ? environValue(environ, "AGENTOP_MANAGED_ID") : undefined;
    if (id) {
      const dir = environValue(environ!, "AGENTISTICS_DIR");
      return { id, ...(dir ? { dir } : {}) };
    }
    const status = readProc(`/proc/${pid}/status`);
    const next = status ? Number(/^PPid:\s*(\d+)/m.exec(status)?.[1]) : NaN;
    if (!Number.isInteger(next)) return undefined;
    pid = next;
  }
  return undefined;
}

export function sessionProof(
  env: Record<string, string | undefined>,
  readKey: (path: string) => string = p => readFileSync(p, "utf8"),
  readProc: ReadProc = defaultReadProc,
  startPid: number = process.ppid,
): { id: string; token: string } | undefined {
  const fromEnv = env.AGENTOP_MANAGED_ID;
  const ancestor = fromEnv ? undefined : ancestorSession(readProc, startPid);
  const id = fromEnv || ancestor?.id;
  if (!id) return undefined;
  const dir = env.AGENTISTICS_DIR || ancestor?.dir || join(env.HOME || homedir(), ".agentistics");
  try {
    const key = Buffer.from(readKey(join(dir, "session-identity.key")).trim(), "hex");
    if (key.length !== 32) return undefined;
    return { id, token: sessionProofToken(key, id) };
  } catch {
    return undefined;
  }
}
