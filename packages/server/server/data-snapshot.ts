/**
 * data-snapshot.ts — the last full `/api/data` build, kept on disk so a RESTART paints at once.
 *
 * Before this, every server start began with an empty in-memory cache: the web app sat on its boot
 * screen for the whole first build — measured at 30–78 s on real machines (git per project being the
 * slowest phase) — on every restart, every reboot, every upgrade. The data had been computed minutes
 * earlier and thrown away when the process exited.
 *
 * What is stored is the build's own serialization (`serializedData`), wrapped with what makes it
 * SAFE to serve again:
 *   - `appVersion`: a snapshot written by another build is DROPPED, never adapted — the response shape
 *     moves between versions and a field read off an older shape is a confident wrong number;
 *   - `homeDir`: a data dir moved to another home describes someone else's machine;
 *   - `v`: this file's own format.
 *
 * It is served ONLY to a client that asked for a partial answer (`/api/data?partial=1`) and only
 * while the first fresh build runs, marked `partial: true, partialReason: 'snapshot'` so the app says
 * it is refreshing. Internal callers (the team uploader, tags, the MCP) never see it: they wait for a
 * fresh build exactly as before, so a stale figure can never be pushed to a central.
 *
 * Written at most every `SNAPSHOT_MIN_INTERVAL_MS` (the build can run every few seconds while
 * sessions write; this file is for the NEXT boot and an hour-old copy serves that just as well),
 * atomically (temp + rename), mode 0600 — it holds the same per-session metrics as the consolidate
 * store beside it. Never on a central: its data lives in Mongo and is scoped per principal.
 */
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export const SNAPSHOT_FORMAT = 1
export const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000

export interface SnapshotHeader { v: number; appVersion: string; homeDir: string; builtAt: string }

/** The file's text: the header's fields plus `data`, spliced around the already-serialized build so
 *  a 10 MB response is never stringified a second time. */
export function encodeSnapshot(h: SnapshotHeader, serializedData: string): string {
  const head = JSON.stringify(h)
  return `${head.slice(0, -1)},"data":${serializedData}}`
}

export type SnapshotVerdict<T> =
  | { ok: true; data: T; builtAt: string }
  | { ok: false; reason: 'unreadable' | 'format' | 'version' | 'home' | 'shape' }

/** Decide whether a stored snapshot may be served here. Pure: the caller does the reading. */
export function decodeSnapshot<T>(text: string, expect: { appVersion: string; homeDir: string }): SnapshotVerdict<T> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, reason: 'unreadable' } }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'unreadable' }
  const p = parsed as Partial<SnapshotHeader> & { data?: unknown }
  if (p.v !== SNAPSHOT_FORMAT) return { ok: false, reason: 'format' }
  if (p.appVersion !== expect.appVersion) return { ok: false, reason: 'version' }
  if (p.homeDir !== expect.homeDir) return { ok: false, reason: 'home' }
  const d = p.data as { statsCache?: unknown; sessions?: unknown; projects?: unknown } | undefined
  if (!d || typeof d !== 'object' || !d.statsCache || !Array.isArray(d.sessions) || !Array.isArray(d.projects)) {
    return { ok: false, reason: 'shape' }
  }
  return { ok: true, data: p.data as T, builtAt: typeof p.builtAt === 'string' ? p.builtAt : '' }
}

export function snapshotPath(dataDir: string): string {
  return join(dataDir, 'cache', 'data-snapshot.json')
}

export async function readSnapshotFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

export async function writeSnapshotFile(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}
