/**
 * self-guard.ts — PURE. Should this long-lived agentop process (the cockpit) reload itself, restart
 * itself onto a new binary, or leave things as they are?
 *
 * ## Why this exists (RES.1, 2026-10-03)
 *
 * The owner's cockpit — bare `agentop`, open since boot — was found at **1.7 GB RSS + 6.5 GB SWAP**
 * after 7h46, running a binary an upgrade had already REPLACED (`/proc/<pid>/exe ->
 * agentop.bak (deleted)`). Swap filled (7.8 / 8 GB), the memory gate refused every new session, and
 * the whole machine crawled. Two things were wrong at once and neither was visible from inside:
 *
 *  1. the process grew without bound — and RSS alone hid most of it, because the kernel had pushed
 *     the bulk into swap. So the budget is checked against **RSS + swap**, never RSS alone;
 *  2. it was the OLD program. No fix shipped after it was opened could ever reach it.
 *
 * ## The decisions, in order
 *
 *  1. **Replaced binary → `restart`.** The file this process was started from is gone (`exe` ends in
 *     ` (deleted)`), so a newer one sits at the same path. Restarting in place onto it is the only
 *     way the user gets the fixes they already installed. Checked FIRST: a restart also releases
 *     every byte, so it answers the memory question too.
 *  2. **Over budget → `reload`**, at most once per `RELOAD_COOLDOWN_MS`. A reload drops the
 *     process's caches and remounts the screen on the tab the user was on.
 *  3. **Over budget again inside the cooldown → `alert`**, never a reload loop: a reload that did
 *     not bring the process under budget will not do so the second time either, and remounting a
 *     screen every minute is its own kind of broken.
 *  4. **The server is NEWER but our binary was not replaced → `alert`** (`outdated`). Restarting
 *     would re-exec the same old file; the honest answer is to say so.
 *  5. Otherwise `none`.
 *
 * An absent measurement is never treated as a reading: no `/proc` means no memory decision.
 */

/** The ceiling for RSS + swap, default. Measured steady state of the cockpit is ~150–250 MB. */
export const SELF_BUDGET_BYTES = 768 * 1024 * 1024

/** A reload that did not help is not repeated inside this window. */
export const RELOAD_COOLDOWN_MS = 30 * 60_000

/** How often the cockpit asks. Cheap: one `/proc` read, one readlink, one local HTTP call. */
export const SELF_CHECK_INTERVAL_MS = 60_000

export interface SelfSample {
  /** RSS + swap of THIS process, bytes; `null` when it could not be read (not Linux). */
  usedBytes: number | null
  rssBytes: number | null
  swapBytes: number | null
  /** The binary this process runs was deleted/replaced on disk. */
  exeReplaced: boolean
  ownVersion: string
  /** What the running server reports; `null` when there is no server to ask. */
  serverVersion: string | null
}

export type SelfDecision =
  | { action: 'none' }
  | { action: 'restart'; reason: 'replaced'; ownVersion: string; serverVersion: string | null }
  | { action: 'reload'; usedBytes: number; budgetBytes: number }
  | { action: 'alert'; reason: 'memory'; usedBytes: number; budgetBytes: number }
  | { action: 'alert'; reason: 'outdated'; ownVersion: string; serverVersion: string }

export function decideSelfGuard(o: {
  sample: SelfSample
  budgetBytes?: number
  /** When this process last reloaded itself, ms epoch; `null` if never. */
  lastReloadMs: number | null
  nowMs: number
  /** `compareVersions` from version.ts, injected so this stays dependency-free. */
  compare: (a: string, b: string) => number
}): SelfDecision {
  const { sample } = o
  const budget = o.budgetBytes ?? SELF_BUDGET_BYTES
  if (sample.exeReplaced) {
    return { action: 'restart', reason: 'replaced', ownVersion: sample.ownVersion, serverVersion: sample.serverVersion }
  }
  if (sample.usedBytes !== null && sample.usedBytes > budget) {
    const cooling = o.lastReloadMs !== null && o.nowMs - o.lastReloadMs < RELOAD_COOLDOWN_MS
    return cooling
      ? { action: 'alert', reason: 'memory', usedBytes: sample.usedBytes, budgetBytes: budget }
      : { action: 'reload', usedBytes: sample.usedBytes, budgetBytes: budget }
  }
  if (sample.serverVersion && o.compare(sample.serverVersion, sample.ownVersion) > 0) {
    return { action: 'alert', reason: 'outdated', ownVersion: sample.ownVersion, serverVersion: sample.serverVersion }
  }
  return { action: 'none' }
}

/** `VmRSS` / `VmSwap` from `/proc/<pid>/status`, in bytes. `null` fields when absent. */
export function parseProcStatusMemory(text: string): { rssBytes: number | null; swapBytes: number | null } {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  return { rssBytes: kb('VmRSS'), swapBytes: kb('VmSwap') }
}

/** Was the binary behind `/proc/<pid>/exe` replaced? The kernel appends ` (deleted)`. */
export function exeWasReplaced(readlinkTarget: string | null): boolean {
  return readlinkTarget !== null && readlinkTarget.endsWith(' (deleted)')
}

/** The env override, in MB, for a machine that wants a different ceiling. Invalid → default. */
export function budgetFromEnv(raw: string | undefined): number {
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 128 ? Math.round(n * 1024 * 1024) : SELF_BUDGET_BYTES
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

export type SelfGuardLang = 'en' | 'pt'

function mbOf(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** The status-line sentence for a decision; `null` for `none`. Names the culprit and the fix. */
export function selfGuardMessage(d: SelfDecision, lang: SelfGuardLang): string | null {
  const pt = lang === 'pt'
  switch (d.action) {
    case 'none':
      return null
    case 'restart': {
      const to = d.serverVersion ? ` (v${d.serverVersion})` : ''
      return pt
        ? `Este agentop (v${d.ownVersion}) foi substituído por uma atualização${to} — reiniciando no lugar, na mesma aba.`
        : `This agentop (v${d.ownVersion}) was replaced by an upgrade${to} — restarting in place, on the same tab.`
    }
    case 'reload':
      return pt
        ? `O agentop passou do orçamento de memória (${mbOf(d.usedBytes)} de RAM+swap, limite ${mbOf(d.budgetBytes)}) — recarregando o estado.`
        : `agentop went over its memory budget (${mbOf(d.usedBytes)} RAM+swap, limit ${mbOf(d.budgetBytes)}) — reloading its state.`
    case 'alert':
      if (d.reason === 'memory') {
        return pt
          ? `O agentop segue acima do orçamento (${mbOf(d.usedBytes)} de RAM+swap, limite ${mbOf(d.budgetBytes)}) mesmo após recarregar — feche-o com q e abra de novo.`
          : `agentop is still over its budget (${mbOf(d.usedBytes)} RAM+swap, limit ${mbOf(d.budgetBytes)}) after a reload — quit with q and open it again.`
      }
      return pt
        ? `Este agentop é v${d.ownVersion} e o servidor é v${d.serverVersion} — feche com q e abra de novo para usar a versão nova.`
        : `This agentop is v${d.ownVersion} and the server is v${d.serverVersion} — quit with q and reopen to run the new version.`
  }
}

/**
 * The argv to restart onto — PURE over `/proc/self/cmdline`'s text. argv[0] is kept when absolute,
 * resolved through `which` when bare, and the rest is kept verbatim. `null` when it resolves to
 * nothing that exists.
 */
export function planRestartArgv(
  cmdline: string,
  which: (cmd: string) => string | null,
  exists: (path: string) => boolean,
): string[] | null {
  const parts = cmdline.split('\0')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  const [argv0, ...rest] = parts
  if (!argv0) return null
  const bin = argv0.startsWith('/') ? argv0 : which(argv0)
  return bin && exists(bin) ? [bin, ...rest] : null
}
