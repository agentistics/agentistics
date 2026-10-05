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
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function sessionProofToken(key: Uint8Array, id: string): string {
  return createHmac("sha256", key).update(`agentop-session:${id}`).digest("hex");
}

export function sessionProof(
  env: Record<string, string | undefined>,
  readKey: (path: string) => string = p => readFileSync(p, "utf8"),
): { id: string; token: string } | undefined {
  const id = env.AGENTOP_MANAGED_ID;
  if (!id) return undefined;
  const dir = env.AGENTISTICS_DIR || join(env.HOME || homedir(), ".agentistics");
  try {
    const key = Buffer.from(readKey(join(dir, "session-identity.key")).trim(), "hex");
    if (key.length !== 32) return undefined;
    return { id, token: sessionProofToken(key, id) };
  } catch {
    return undefined;
  }
}
