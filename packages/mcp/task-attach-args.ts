/**
 * task-attach-args.ts — the pure half of `agentistics_task_attach`.
 *
 * The tool runs in the MCP PROCESS, which runs as the user (like the session that calls it): that
 * process reads each local file and uploads it through the chat's own door (`POST /api/fleet/attach`),
 * then leaves ONE comment carrying the returned references and the producing `sessionId`. The server
 * deliberately has no route that reads a path it is handed.
 *
 * What is decided here, without touching the disk: how many files, which kinds (the same
 * image/video/PDF set the attachment door serves — anything else would upload and then not render)
 * and the 20 MB ceiling. The caller supplies sizes after `stat`.
 */
export const MAX_ATTACH_FILES = 10;
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

const KINDS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg",
  "mp4", "m4v", "mov", "webm", "ogv", "pdf",
]);

export const attachKindOf = (path: string): string | null => {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return KINDS.has(ext) ? ext : null;
};

export type AttachPlan =
  | { ok: true; sessionId: string; files: string[]; subtaskId?: string; note: string; ref: string }
  | { ok: false; message: string };

export function planTaskAttach(args: unknown): AttachPlan {
  const a = (args ?? {}) as Record<string, unknown>;
  const ref = typeof a.ref === "string" ? a.ref.trim() : "";
  if (!ref) return { ok: false, message: "`ref` (the task) is required." };
  const sessionId = typeof a.sessionId === "string" ? a.sessionId.trim() : "";
  if (!sessionId) return { ok: false, message: "`sessionId` is required: say which session produced these files." };
  const files = Array.isArray(a.files) ? a.files.filter((f): f is string => typeof f === "string" && f.trim() !== "").map(f => f.trim()) : [];
  if (files.length === 0) return { ok: false, message: "`files` needs at least one local path." };
  if (files.length > MAX_ATTACH_FILES) return { ok: false, message: `At most ${MAX_ATTACH_FILES} files per call (got ${files.length}).` };
  const bad = files.find(f => attachKindOf(f) === null);
  if (bad) return { ok: false, message: `"${bad}" is not an image, video or PDF — only those are shown on the board.` };
  const subtaskId = typeof a.subtaskId === "string" && a.subtaskId.trim() ? a.subtaskId.trim() : undefined;
  return { ok: true, ref, sessionId, files: [...new Set(files)], ...(subtaskId ? { subtaskId } : {}), note: typeof a.note === "string" ? a.note : "" };
}

export const checkAttachSize = (path: string, bytes: number): string | null =>
  bytes === 0 ? `"${path}" is empty.`
    : bytes > MAX_ATTACH_BYTES ? `"${path}" is over the ${MAX_ATTACH_BYTES / (1024 * 1024)} MB attachment limit.`
    : null;

/** The comment this tool posts: the uploaded references + the producing session, through the one comments door. */
export function attachCommentPayload(
  plan: Extract<AttachPlan, { ok: true }>,
  uploaded: { name: string; path: string }[],
): Record<string, unknown> {
  return {
    body: plan.note,
    author: `session:${plan.sessionId.slice(0, 12)}`,
    sessionId: plan.sessionId,
    attachments: uploaded,
    ...(plan.subtaskId ? { subtaskId: plan.subtaskId } : {}),
  };
}
