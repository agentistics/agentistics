/**
 * installs-ledger.ts — the install ledger (ENTREGA.GARANTIDA §4.2): `<dataDir>/installs.jsonl`.
 *
 * On every boot, when `{repoKey, sha, version}` differs from the last VALID line, one line is appended:
 * `{repoKey, version, buildSha, tree, firstSeenAt, previousBuildSha}`. Append-only, 0600, capped at 500
 * lines (the oldest are trimmed atomically — tmp file + rename). Boots that change nothing write nothing.
 *
 * It must never take a boot down: a corrupt line is skipped (and a truncated, newline-less tail is not glued
 * onto), and `recordInstall` returns the failure instead of throwing.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuildIdentity } from './build-identity.ts'

export const INSTALLS_CAP = 500

export interface InstallEntry {
  repoKey: string | null
  version: string
  buildSha: string | null
  tree: string | null
  firstSeenAt: string
  previousBuildSha: string | null
}

export function installsFile(dataDir: string): string { return join(dataDir, 'installs.jsonl') }

const nul = (v: unknown) => v === null || typeof v === 'string'

/** PURE. Valid entries in file order; every line that is not a whole entry is counted, never thrown. */
export function parseLedger(raw: string): { entries: InstallEntry[]; skipped: number } {
  const entries: InstallEntry[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (!o || typeof o !== 'object' || typeof o.version !== 'string' || typeof o.firstSeenAt !== 'string'
        || !nul(o.repoKey) || !nul(o.buildSha) || !nul(o.tree) || !nul(o.previousBuildSha)) { skipped++; continue }
      entries.push({ repoKey: o.repoKey as string | null, version: o.version, buildSha: o.buildSha as string | null, tree: o.tree as string | null, firstSeenAt: o.firstSeenAt, previousBuildSha: o.previousBuildSha as string | null })
    } catch { skipped++ }
  }
  return { entries, skipped }
}

/** PURE. The line to append, or null when `{repoKey, sha, version}` is what the last line already says. */
export function planInstall(last: InstallEntry | null, now: { build: BuildIdentity; version: string }, at: Date): InstallEntry | null {
  if (last && last.repoKey === now.build.repoKey && last.buildSha === now.build.sha && last.version === now.version) return null
  return {
    repoKey: now.build.repoKey, version: now.version, buildSha: now.build.sha, tree: now.build.tree,
    firstSeenAt: at.toISOString(), previousBuildSha: last?.buildSha ?? null,
  }
}

export type RecordResult = { appended: false; error?: string } | { appended: true; entry: InstallEntry; trimmed: number }

/** IO. Never throws. */
export function recordInstall(o: { file: string; build: BuildIdentity; version: string; now?: Date }): RecordResult {
  try {
    const raw = existsSync(o.file) ? readFileSync(o.file, 'utf8') : ''
    const { entries } = parseLedger(raw)
    const entry = planInstall(entries.at(-1) ?? null, { build: o.build, version: o.version }, o.now ?? new Date())
    if (!entry) return { appended: false }
    const line = JSON.stringify(entry) + '\n'
    if (entries.length + 1 > INSTALLS_CAP) {
      const keep = [...entries.slice(entries.length + 1 - INSTALLS_CAP), entry]
      const tmp = `${o.file}.${process.pid}.tmp`
      writeFileSync(tmp, keep.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
      renameSync(tmp, o.file)
      chmodSync(o.file, 0o600)
      return { appended: true, entry, trimmed: entries.length + 1 - INSTALLS_CAP }
    }
    // A truncated last line has no newline: start on a fresh one rather than gluing two records together.
    appendFileSync(o.file, (raw !== '' && !raw.endsWith('\n') ? '\n' : '') + line, { mode: 0o600 })
    chmodSync(o.file, 0o600)
    return { appended: true, entry, trimmed: 0 }
  } catch (err) {
    return { appended: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** IO. The valid entries, oldest first; an absent or unreadable file is an empty ledger. */
export function readInstalls(file: string): InstallEntry[] {
  try { return parseLedger(readFileSync(file, 'utf8')).entries } catch { return [] }
}

/** The boot's one call. */
export async function recordBootInstall(): Promise<RecordResult> {
  const [{ AGENTISTICS_DATA_DIR }, { CURRENT_VERSION }, { currentBuild }] = await Promise.all([import('./config.ts'), import('./version.ts'), import('./build-info.ts')])
  return recordInstall({ file: installsFile(AGENTISTICS_DATA_DIR), build: await currentBuild(), version: CURRENT_VERSION })
}

/** PURE. What `agentop flow installs` prints (newest last). */
export function renderInstalls(entries: readonly InstallEntry[]): string {
  if (entries.length === 0) return 'no installs recorded yet'
  return entries.map(e => [e.firstSeenAt, e.version, e.buildSha?.slice(0, 12) ?? '-', `←${e.previousBuildSha?.slice(0, 12) ?? '-'}`, e.repoKey ?? '-'].join('\t')).join('\n')
}
