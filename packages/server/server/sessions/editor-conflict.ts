/**
 * editor-conflict.ts — PURE: the rule the whole feature's safety promise rests on.
 *
 * A save must NEVER silently clobber a change an agent made on disk while the file was open in the
 * editor. This is a plain mtime check, not a content hash: cheap on every save, and sufficient —
 * the only thing that matters is "did something else touch this file since I read it", not what
 * changed. Nothing is written automatically on a mismatch in either direction; the caller
 * (`editor-fs.ts`) refuses the write and hands the current disk content back so the person can
 * choose, which is the "agent's work always wins the silent case" rule stated in words rather than
 * enforced by picking a winner in code.
 */

export type WriteRefusal = 'conflict'

export type WritePlan =
  | { ok: true }
  | { ok: false; reason: WriteRefusal; diskMtimeMs: number }

export function planFileWrite(o: { expectedMtimeMs: number; diskMtimeMs: number }): WritePlan {
  return o.expectedMtimeMs === o.diskMtimeMs
    ? { ok: true }
    : { ok: false, reason: 'conflict', diskMtimeMs: o.diskMtimeMs }
}
