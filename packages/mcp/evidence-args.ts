/**
 * evidence-args.ts — turns `agentistics_task_evidence` arguments into the REST request (`/api/tasks/<ref>/evidence`).
 * The tool is a door and nothing more: it sends WHAT the caller names (kind, payload, piece) and the session proof; every
 * hash, binding, time and verdict is the server's. `filePath` is read HERE (the worker's worktree is on this machine) and sent
 * as bytes, with the 8 MB cap enforced before the file is read into memory.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

export interface EvidenceHttp { action: "list" | "add" | "remove"; ref: string; query: string; body?: Record<string, unknown> }

export function evidenceRequestOf(a: Record<string, unknown>, session: unknown): EvidenceHttp {
  if (typeof a.ref !== "string" || !a.ref) throw new Error("ref is required (the task id)");
  const action = a.action === undefined ? "add" : a.action;
  const ref = a.ref;
  const subtaskId = typeof a.subtaskId === "string" && a.subtaskId ? a.subtaskId : undefined;
  if (action === "list") return { action: "list", ref, query: subtaskId ? `?subtaskId=${encodeURIComponent(subtaskId)}` : "" };
  // F5 (S0d integration): a write with no session proof is refused HERE, before the transport — the server would read it as
  // `unattributed` and refuse anyway, but the MCP never sends a write that cannot say whose it is.
  if (session === undefined || session === null) {
    throw new Error("agentistics_task_evidence add/remove needs the session proof: run it from a session agentop started; the owner attaches from the web or `agentop task evidence add --owner`");
  }
  if (action === "remove") {
    if (typeof a.evidenceId !== "string" || !a.evidenceId) throw new Error("evidenceId is required for remove");
    return { action: "remove", ref, query: "", body: { ...(subtaskId ? { subtaskId } : {}), evidenceId: a.evidenceId, session } };
  }
  if (action !== "add") throw new Error("action must be add | list | remove");
  if (typeof a.kind !== "string" || !a.kind) throw new Error("kind is required for add");
  const body: Record<string, unknown> = { kind: a.kind, ...(subtaskId ? { subtaskId } : {}), session };
  const payloads = ["filePath", "fileId", "repoRef", "probe"].filter(k => a[k] !== undefined);
  if (payloads.length !== 1) throw new Error("name exactly ONE payload: filePath, fileId, repoRef or probe");
  if (typeof a.filePath === "string") {
    let size: number;
    try { size = statSync(a.filePath).size; } catch { throw new Error(`cannot read ${a.filePath}`); }
    // The cap is checked on the stat, BEFORE the bytes are read: a 2 GB file never reaches memory.
    if (size > EVIDENCE_MAX_BYTES) throw new Error(`${a.filePath} is ${size} bytes; an upload is limited to ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB`);
    body.bytesBase64 = readFileSync(a.filePath).toString("base64");
    body.name = typeof a.name === "string" && a.name ? a.name : basename(a.filePath);
  } else if (a.fileId !== undefined) body.fileId = a.fileId;
  else if (a.repoRef !== undefined) body.repoRef = a.repoRef;
  else body.probe = a.probe;
  return { action: "add", ref, query: "", body };
}
