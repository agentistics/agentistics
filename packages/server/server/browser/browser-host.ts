/**
 * browser-host.ts — the lifecycle of every Chromium agentistics runs (spec §1.3–§1.4).
 *
 * One record per OWNER (a managed session, or the person). Nothing here enters `managed-sessions.json`:
 * a browser is not a session (the same lesson as the utility shell) and must never be heartbeated,
 * probed for attention or counted as "waiting on you".
 *
 * The rules this file keeps, each one a thing QA will try to break:
 *
 * - **Start and stop only by the SAVED PID.** The PID is the one `spawn` returned; a stop is
 *   `process.kill(pid, SIGTERM)`, then SIGKILL after `KILL_GRACE_MS`. Never a kill by name, never a
 *   `pkill`. The orphan sweep kills a recorded PID only when that process's own cmdline names the
 *   recorded `--user-data-dir` — a recycled PID is never touched.
 * - **Admission is decided synchronously.** Memory is read FIRST, then the decision and the `starting`
 *   placeholder are made in the same tick, so two requests cannot both pass a ceiling of one.
 * - **Profiles are throwaway.** Created fresh (an old folder at that path is removed first) with 0700,
 *   deleted when the browser stops, and swept on boot: a folder no live browser of a live host holds is
 *   deleted.
 * - **The pipe ties the browser to us.** CDP rides fds 3/4; when this process dies the pipe closes and
 *   Chromium exits on its own. `pids.json` is the backstop the sweep reads.
 * - **Memory is watched as PSS** every `WATCH_INTERVAL_MS` while at least one browser lives (and not at
 *   all otherwise): trim the oldest inactive tab above 900 MB, stop the browser above 1.2 GB. Where
 *   `systemd-run --user --scope` works the spawn also carries `MemoryMax=1200M MemorySwapMax=0`.
 * - **Idle shutdown**: 10 min (session) / 20 min (personal) with nobody watching.
 *
 * All IO is behind `BrowserHostDeps` so the integration test runs it against a real headless shell
 * inside `agentop run --rm`, and unit tests can drive it with fakes.
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { admissionSentence, decideAdmission, type AdmissionRefusal, type LiveBrowserView } from './browser-admission'
import { browserBinSentence, findBrowserBin, type BrowserBin } from './browser-bin'
import {
  KILL_GRACE_MS, MAX_LIVE_BROWSERS, MAX_PERSONAL_BROWSERS, MAX_SESSION_BROWSERS, MAX_TABS_PERSONAL, MAX_TABS_SESSION,
  MIN_AVAILABLE_BYTES, PSS_KILL_BYTES, PSS_TRIM_BYTES, RSS_FALLBACK_FACTOR, START_TIMEOUT_MS, WATCH_INTERVAL_MS, browserArgv, descendants, idleExpired, memoryVerdict,
  ownerKey, parseSmapsRollup, planOrphanSweep, planUnrecordedOrphans, ppidFromStat, profileDirFor, scopeUnitName,
  mustCloseNewTarget, scopeWrap, statusLabel, statusTitle, statusUrl, tabToTrim, urlBlockReason, validManagedId, needsResolve, resolvedBlockReason,
  startTimeFromStat,
  type BlockContext, type BlockReason, type BrowserOwner, type MemoryVerdict, type PidRecord, type SweepPlan,
} from './browser-spec'
import { CdpClient, type CdpEvent } from './cdp-client'
import type { ActionHost, BlockedHit, LastAction } from './browser-actions'

// ---------------------------------------------------------------------------------------------------
// Dependencies

export interface SpawnedBrowser {
  pid: number
  /** Resolves with the exit code/signal once the process is gone. */
  exited: Promise<void>
  hasExited: () => boolean
  /** How it ended (`code=… signal=…`), for the log of a crash. */
  exitInfo?: () => string
  cdpOut: Writable
  cdpIn: Readable
}

export interface BrowserHostDeps {
  /** S4c: after a browser's pipe fds are closed, make the runtime drop every stale handle to them NOW (Bun
   *  finalizers close an fd NUMBER late, and the kernel has already handed it to the next browser's pipe —
   *  Chrome then reads EOF and exits 0 half a second after `close → navigate`). Default: a forced GC. */
  settleFds?: () => Promise<void>
  /** `<data dir>/browser`. */
  root: string
  bin: () => BrowserBin
  memAvailable: () => Promise<number | null>
  now: () => number
  spawn: (bin: string, argv: string[]) => SpawnedBrowser
  /** Send a signal to a saved PID. Throws ESRCH when it is gone, like `process.kill`. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void
  /** `/proc` reads; null off Linux. */
  proc: ProcReader | null
  /** Can `systemd-run --user --scope` actually start a scope here? Asked once. */
  scopeWorks: () => boolean
  /** Ports agentistics itself serves on — a browser may never load them. */
  agentisticsPorts: readonly number[]
  /** Is this managed session still alive? `undefined` = unknown (kept). */
  sessionLive?: (managedId: string) => boolean | undefined
  selfPid: number
  /** Explicit opt-out of the sandbox (`AGENTISTICS_BROWSER_NO_SANDBOX=1`). */
  forceNoSandbox?: boolean
  /** DNS for the block rules (a name on a guarded port is resolved before it may load). */
  resolve?: (hostname: string) => Promise<string[]>
  /** This machine's interface addresses (a LAN IP reaches a 0.0.0.0-bound server). */
  selfAddresses?: () => string[]
  /** Debugging ports of browsers this machine runs in PORT mode (none in pipe mode, the default): a page
   *  may never reach one — it would drive another browser. */
  debugPorts?: () => readonly number[]
  log?: (line: string) => void
}

export interface ProcReader {
  /** pid → ppid for every process. */
  ppids: () => Map<number, number>
  smapsRollup: (pid: number) => string | null
  /** NUL-joined argv, or null. */
  cmdline: (pid: number) => string | null
  /** `/proc/<pid>/cgroup`, or null. */
  cgroup?: (pid: number) => string | null
  /** Is this pid gone (absent, or a zombie)? */
  gone?: (pid: number) => boolean
  /** `starttime` of a pid (the identity a recycled pid cannot share), or null. */
  startTime?: (pid: number) => number | null
}

// ---------------------------------------------------------------------------------------------------
// State

const DOOMED_CLOSE_FALLBACK_MS = 1_500

interface TabState { targetId: string; url: string; title: string; lastActiveMs: number }

interface Entry {
  key: string
  owner: BrowserOwner
  phase: 'starting' | 'live' | 'stopping'
  pid: number | null
  profileDir: string
  startedAt: number
  lastActivityMs: number
  viewers: number
  /** Personal only: when the person minimized it (null = on screen). A minimized one idles out on its own clock. */
  minimizedAt: number | null
  cdp: CdpClient | null
  child: SpawnedBrowser | null
  tabs: Map<string, TabState>
  activeTab: string | null
  scope: boolean
  scopeEscaped: boolean
  sandbox: boolean
  memory: MemoryVerdict | null
  stopping: Promise<void> | null
  /** page targetId → its flat CDP session (auto-attached, Fetch-intercepted). */
  tabSessions: Map<string, string>
  /** Popups past the tab ceiling, waiting to be resumed and then closed (never closed while paused). */
  doomed: Set<string>
  /** Every attached CDP session (pages, iframes, workers) → the page target it belongs to. */
  sessionPage: Map<string, string>
  /** What the block rules refused lately (newest first) — an action explains its own refusals from it. */
  blocked: BlockedHit[]
  lastAction: LastAction | null
  /** S4: who else hears this browser's CDP events (the screencast). */
  eventListeners: Set<(ev: CdpEvent) => void>
  /** S4: page targets whose main frame is loading. */
  loading: Set<string>
}

/** S4: what the live screen's `state` event is built from. */
export interface StreamFacts {
  owner: BrowserOwner
  activeTab: string | null
  tabs: { targetId: string; url: string; title: string; active: boolean; loading: boolean }[]
  lastAction: LastAction | null
}

export type StopReason = 'requested' | 'idle' | 'memory' | 'session-ended' | 'evicted' | 'server-stop' | 'crashed' | 'start-failed'

export interface BrowserSummary {
  key: string
  owner: BrowserOwner
  phase: 'starting' | 'live' | 'stopping'
  pid: number | null
  startedAt: number
  lastActivityMs: number
  viewers: number
  /** Personal only: hidden by the person (Chromium and its tabs kept). */
  minimized: boolean
  tabs: { targetId: string; url: string; title: string; active: boolean }[]
  memory: { basis: 'pss' | 'rss' | 'none'; bytes: number | null; action: 'ok' | 'trim' | 'kill' } | null
  /** The systemd MemoryMax scope HOLDS this browser (checked in its cgroup, not assumed). */
  scope: boolean
  /** Started in our scope and moved itself out (full Google Chrome does). */
  scopeEscaped: boolean
  sandbox: boolean
  /** The last few URLs the block rules refused (origin+path), redirects marked. */
  blocked: { url: string; reason: BlockReason; resourceType: string; redirect: boolean; at: number }[]
  lastAction: { kind: string; label: string; at: number } | null
}

export interface BrowserStatus {
  executable: BrowserBin & { sentence: string }
  live: BrowserSummary[]
  ceilings: { live: number; session: number; personal: number; tabsSession: number; tabsPersonal: number }
  memory: { available: number | null; minAvailable: number; measured: boolean; trimBytes: number; killBytes: number; rssFallbackFactor: number }
  /** The profile folders on disk (S12): what "Delete profiles" would remove. Live browsers hold theirs. */
  profiles: { count: number }
  scope: { available: boolean }
  /** The last few stops and why — what the card/panel says when a browser is gone. */
  recentStops: { key: string; reason: StopReason; at: number }[]
  /** The person's tab list kept after a minimized browser was stopped (null = none). */
  personalSaved: { tabs: number } | null
  lastSweep: { at: number; killed: number; removedDirs: number; keptForOtherHost: number } | null
}

export type StartResult =
  | { ok: true; key: string; pid: number; reused: boolean; evicted?: string }
  | { ok: false; reason: AdmissionRefusal | 'no-executable' | 'start-failed' | 'invalid-owner'; sentence: string }

// ---------------------------------------------------------------------------------------------------

export class BrowserHost {
  private entries = new Map<string, Entry>()
  private timer: ReturnType<typeof setInterval> | null = null
  private recentStops: BrowserStatus['recentStops'] = []
  private lastSweep: BrowserStatus['lastSweep'] = null
  private scopeAvailable: boolean | null = null
  private sandboxBroken = false
  private ticking = false

  constructor(private readonly d: BrowserHostDeps) {}

  private log(line: string): void { this.d.log?.(`[browser] ${line}`) }

  // -------------------------------------------------------------------------------------------- start

  async start(owner: BrowserOwner): Promise<StartResult> {
    if (owner.kind === 'session' && !validManagedId(owner.managedId)) {
      return { ok: false, reason: 'invalid-owner', sentence: 'Invalid session id.' }
    }
    const bin = this.d.bin()
    if (!bin.found) return { ok: false, reason: 'no-executable', sentence: browserBinSentence(bin) }

    // Memory FIRST (the only await before the decision), then decide and reserve in one tick.
    const mem = await this.d.memAvailable()
    const key = ownerKey(owner)
    const existing = this.entries.get(key)
    if (existing && existing.phase !== 'stopping') {
      if (existing.phase === 'starting') await this.waitLive(existing)
      const now = this.entries.get(key)
      if (now && now.phase === 'live' && now.pid !== null) {
        now.lastActivityMs = this.d.now()
        return { ok: true, key, pid: now.pid, reused: true }
      }
    }
    if (existing?.stopping) await existing.stopping

    const decision = decideAdmission({ owner, live: this.views(), memAvailable: mem, now: this.d.now() })
    if (!decision.ok) return { ok: false, reason: decision.reason, sentence: admissionSentence(decision.reason, 'en', decision.memAvailable) }
    if ('reuse' in decision) {
      const e = this.entries.get(decision.reuse)!
      if (e.phase === 'starting') await this.waitLive(e)
      if (e.phase === 'live' && e.pid !== null) return { ok: true, key, pid: e.pid, reused: true }
      return { ok: false, reason: 'start-failed', sentence: 'The browser could not be started.' }
    }

    const entry: Entry = {
      key, owner, phase: 'starting', pid: null, profileDir: profileDirFor(this.d.root, owner),
      startedAt: this.d.now(), lastActivityMs: this.d.now(), viewers: 0, minimizedAt: null, cdp: null, child: null,
      tabs: new Map(), activeTab: null, scope: false, scopeEscaped: false, sandbox: true, memory: null, stopping: null,
      tabSessions: new Map(), doomed: new Set(), sessionPage: new Map(), blocked: [], lastAction: null,
      eventListeners: new Set(), loading: new Set(),
    }
    this.entries.set(key, entry)
    if (decision.evict) await this.stop(decision.evict, 'evicted')

    const launched = await this.launch(entry, bin)
    if (!launched) {
      if (entry.stopping) await entry.stopping
      if (this.entries.get(key) === entry) this.entries.delete(key)
      this.removeProfile(entry.profileDir)
      this.writeRecords()
      entry.child = null
      entry.cdp = null
      await this.d.settleFds?.()
      this.noteStop(key, 'start-failed')
      return { ok: false, reason: 'start-failed', sentence: 'The browser could not be started.' }
    }
    this.ensureTimer()
    return { ok: true, key, pid: entry.pid!, reused: false, ...(decision.evict ? { evicted: decision.evict } : {}) }
  }

  private startWaiters = new Map<string, Array<() => void>>()
  private waitLive(e: Entry): Promise<void> {
    if (e.phase !== 'starting') return Promise.resolve()
    return new Promise((res) => {
      const list = this.startWaiters.get(e.key) ?? []
      list.push(res)
      this.startWaiters.set(e.key, list)
    })
  }
  private releaseWaiters(key: string): void {
    for (const r of this.startWaiters.get(key) ?? []) r()
    this.startWaiters.delete(key)
  }

  /** Spawn, attach CDP over the pipe, prove it answers. Retries once without the sandbox when the
   *  sandboxed attempt dies before answering (WSL/containers without user namespaces). */
  private async launch(entry: Entry, bin: Extract<BrowserBin, { found: true }>): Promise<boolean> {
    const attempts: boolean[] = this.d.forceNoSandbox || this.sandboxBroken ? [false] : [true, false]
    try {
      for (const sandbox of attempts) {
        if (entry.phase !== 'starting') return false
        const ok = await this.launchOnce(entry, bin, sandbox)
        if (ok) return true
        if (entry.phase !== 'starting') return false
        if (sandbox) {
          this.log(`sandboxed start failed for ${entry.key}; retrying with --no-sandbox`)
          this.sandboxBroken = true
        }
      }
      return false
    } finally {
      this.releaseWaiters(entry.key)
    }
  }

  private async launchOnce(entry: Entry, bin: Extract<BrowserBin, { found: true }>, sandbox: boolean): Promise<boolean> {
    this.prepareProfile(entry.profileDir)
    const argv = browserArgv({ kind: bin.kind, profileDir: entry.profileDir, noSandbox: !sandbox })
    const useScope = this.scopeOk()
    const unit = scopeUnitName(entry.key, randomBytes(4).toString('hex'))
    const cmd = useScope ? scopeWrap(bin.path, argv, unit) : { bin: bin.path, argv }
    let child: SpawnedBrowser
    try {
      child = this.d.spawn(cmd.bin, cmd.argv)
    } catch (e) {
      this.log(`spawn failed for ${entry.key}: ${String(e)}`)
      return false
    }
    entry.pid = child.pid
    entry.child = child
    entry.scope = useScope
    entry.sandbox = sandbox
    this.writeRecords()
    const cdp = new CdpClient(child.cdpOut, child.cdpIn)
    entry.cdp = cdp
    // Events first: auto-attach announces every page (the first one included) the moment it is on.
    cdp.on((ev) => this.onEvent(entry, ev))
    try {
      await cdp.send('Browser.getVersion', {}, undefined, START_TIMEOUT_MS)
      await cdp.send('Target.setDiscoverTargets', { discover: true })
      // Every target (existing and new: tabs, popups, then — per session — iframes and workers) is
      // attached PAUSED, gets `Fetch` interception, and only then runs. A popup or an iframe cannot load
      // a byte before the block rules see its requests, redirects included (measured S2: a 302 to a
      // blocked port is a second `Fetch.requestPaused` and is refused).
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      const { targetInfos } = await cdp.send<{ targetInfos: any[] }>('Target.getTargets')
      for (const t of targetInfos) if (t.type === 'page') this.upsertTab(entry, t)
      entry.activeTab = [...entry.tabs.keys()][0] ?? null
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
    } catch (e) {
      this.log(`browser ${entry.key} did not answer: ${String(e)}`)
      cdp.close('start failed')
      await this.killPid(child)
      entry.pid = null
      entry.child = null
      entry.cdp = null
      return false
    }
    if (entry.phase !== 'starting' || this.entries.get(entry.key) !== entry) {
      // Stopped (server stop, eviction) while it was starting: never let it become a live orphan.
      cdp.close('stopped while starting')
      await this.killPid(child)
      return false
    }
    if (useScope) {
      // Full Google Chrome moves ITSELF into its own systemd scope (`app-com.google.Chrome-<pid>.scope`,
      // measured on Chrome 146), escaping our MemoryMax. Read where it actually is; claim the scope only
      // when it held. The PSS watcher is the brake either way.
      const cg = this.d.proc?.cgroup?.(child.pid) ?? null
      entry.scope = cg !== null && cg.includes(`/${unit}.scope`)
      entry.scopeEscaped = !entry.scope
      if (entry.scopeEscaped) this.log(`${entry.key} left the memory scope (cgroup: ${cg?.trim() ?? 'unreadable'})`)
    }
    cdp.onClose((why) => {
      // The pipe closed without us asking: the browser crashed or was killed from outside.
      if (entry.phase === 'live') this.log(`${entry.key}: the CDP pipe closed (${why})`)
      if (entry.phase === 'live') void this.stop(entry.key, 'crashed')
    })
    void child.exited.then(() => {
      if (entry.phase === 'live') this.log(`${entry.key}: the browser process ended on its own (${child.exitInfo?.() ?? "unknown"}); tabs=${[...entry.tabs.keys()].map(t => t.slice(0, 5)).join(",")} doomed=${entry.doomed.size}`)
      if (entry.phase === 'live' && this.entries.get(entry.key) === entry) void this.stop(entry.key, 'crashed')
    })
    entry.phase = 'live'
    this.log(`started ${entry.key} pid=${entry.pid} scope=${entry.scope}${entry.scopeEscaped ? ' (escaped)' : ''} sandbox=${sandbox}`)
    return true
  }

  private onEvent(entry: Entry, ev: CdpEvent): void {
    if (ev.method === 'Target.targetCreated' || ev.method === 'Target.targetInfoChanged') {
      const info = ev.params?.targetInfo
      if (info?.type === 'page') {
        const max = entry.owner.kind === 'personal' ? MAX_TABS_PERSONAL : MAX_TABS_SESSION
        if (mustCloseNewTarget(entry.tabs.has(info.targetId), entry.tabs.size, max)) {
          // A tab the page opened itself (window.open) past the ceiling: close it and say so.
          // NOT closed here: a target auto-attached PAUSED and closed before it runs leaves its opener
          // waiting on the window it asked for, and every later action on the opener times out (measured,
          // S2fix3-diag-1.log). `setupAttached` resumes it (Fetch is on, so nothing loads) and then closes it;
          // the timer covers a popup that never reaches us attached.
          if (!entry.doomed.has(info.targetId)) {
            this.log(`${entry.key} page opened a tab past the ceiling of ${max}; closing ${info.targetId} (${statusUrl(info.url ?? '')})`)
            entry.doomed.add(info.targetId)
            const t = setTimeout(() => this.closeDoomed(entry, info.targetId), DOOMED_CLOSE_FALLBACK_MS)
            ;(t as any).unref?.()
          }
        } else if (!entry.doomed.has(info.targetId)) this.upsertTab(entry, info)
      }
    } else if (ev.method === 'Target.targetDestroyed') {
      entry.tabs.delete(ev.params?.targetId)
      entry.doomed.delete(ev.params?.targetId)
      entry.tabSessions.delete(ev.params?.targetId)
      if (entry.activeTab === ev.params?.targetId) entry.activeTab = [...entry.tabs.keys()][0] ?? null
    } else if (ev.method === 'Target.attachedToTarget') {
      void this.setupAttached(entry, ev)
    } else if (ev.method === 'Target.detachedFromTarget') {
      const sid = ev.params?.sessionId
      entry.sessionPage.delete(sid)
      for (const [t, s] of entry.tabSessions) if (s === sid) entry.tabSessions.delete(t)
    } else if (ev.method === 'Fetch.requestPaused' && ev.sessionId) {
      void this.onPaused(entry, ev)
    } else if (ev.method === 'Network.webSocketCreated' && ev.sessionId) {
      void this.onWebSocket(entry, ev)
    } else if ((ev.method === 'Page.frameStartedLoading' || ev.method === 'Page.frameStoppedLoading') && ev.sessionId) {
      // A page target's main frame id IS its target id; an iframe's loading is not the page loading.
      const page = entry.sessionPage.get(ev.sessionId)
      if (page && ev.params?.frameId === page) {
        if (ev.method === 'Page.frameStartedLoading') entry.loading.add(page)
        else { entry.loading.delete(page); void this.refreshTab(entry, page) }
      }
    }
    if (ev.method === 'Target.targetDestroyed') entry.loading.delete(ev.params?.targetId)
    for (const fn of entry.eventListeners) {
      try { fn(ev) } catch { /* a listener never breaks the browser */ }
    }
  }

  /** S4: hear this browser's CDP events (the screencast). The returned function stops listening. */
  onCdpEvent(key: string, fn: (ev: CdpEvent) => void): () => void {
    const e = this.entries.get(key)
    if (!e) return () => {}
    e.eventListeners.add(fn)
    return () => { e.eventListeners.delete(fn) }
  }

  /** S4: the live screen's facts — `null` when there is no live browser for this key. */
  streamFacts(key: string): StreamFacts | null {
    const e = this.entries.get(key)
    if (!e || e.phase !== 'live') return null
    const active = e.activeTab && e.tabs.has(e.activeTab) ? e.activeTab : null
    return {
      owner: e.owner,
      activeTab: active,
      tabs: [...e.tabs.values()].map(t => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.targetId === active, loading: e.loading.has(t.targetId) })),
      lastAction: e.lastAction,
    }
  }

  private closeDoomed(entry: Entry, targetId: string): void {
    if (!entry.doomed.delete(targetId)) return
    void entry.cdp?.send('Target.closeTarget', { targetId }).catch(() => {})
  }

  /** A target was attached (paused when auto-attached): intercept, then let it run. Every step may fail
   *  for a target type that lacks the domain (a worker has no `Page`); the run always happens, or the
   *  target would hang forever. */
  private async setupAttached(entry: Entry, ev: CdpEvent): Promise<void> {
    const cdp = entry.cdp
    const sid: string | undefined = ev.params?.sessionId
    const info = ev.params?.targetInfo
    if (!cdp || !sid || !info) return
    const page = info.type === 'page' ? info.targetId : (ev.sessionId ? entry.sessionPage.get(ev.sessionId) : undefined)
    if (page) entry.sessionPage.set(sid, page)
    if (info.type === 'page' && entry.doomed.has(info.targetId)) {
      // A popup past the tab ceiling: intercept, let it run once so its opener is not left waiting, close it.
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid).catch(() => {})
      if (ev.params?.waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {})
      this.closeDoomed(entry, info.targetId)
      return
    }
    if (info.type === 'page') { entry.tabSessions.set(info.targetId, sid); this.upsertTab(entry, info) }
    const steps: Promise<unknown>[] = [
      cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid),
      cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sid),
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid),
    ]
    if (info.type === 'page') steps.push(cdp.send('Page.enable', {}, sid))
    await Promise.allSettled(steps)
    if (ev.params?.waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {})
  }

  private blockCtx(): BlockContext {
    return { agentisticsPorts: this.d.agentisticsPorts, debugPorts: this.d.debugPorts?.() ?? [], selfAddresses: this.selfAddrs() }
  }

  private selfAddrMemo: { at: number; list: string[] } | null = null
  private selfAddrs(): string[] {
    const now = Date.now()
    if (!this.selfAddrMemo || now - this.selfAddrMemo.at > 60_000) {
      let list: string[] = []
      try { list = (this.d.selfAddresses?.() ?? []).map(a => a.toLowerCase()) } catch { list = [] }
      this.selfAddrMemo = { at: now, list }
    }
    return this.selfAddrMemo.list
  }

  /** The block rules for one URL, DNS included (a name on a guarded port that resolves to this machine). */
  async blockReasonFor(url: string): Promise<BlockReason | null> {
    const ctx = this.blockCtx()
    const direct = urlBlockReason(url, ctx)
    if (direct) return direct
    if (!needsResolve(url, ctx) || !this.d.resolve) return null
    try {
      const host = new URL(url).hostname
      const addrs = await Promise.race([
        this.d.resolve(host),
        new Promise<string[]>((r) => setTimeout(() => r([]), 2_000)),
      ])
      return resolvedBlockReason(url, addrs, ctx)
    } catch { return null }
  }

  private async onPaused(entry: Entry, ev: CdpEvent): Promise<void> {
    const cdp = entry.cdp
    const p = ev.params ?? {}
    const url: string = p.request?.url ?? ''
    if (!cdp) return
    const reason = await this.blockReasonFor(url)
    if (reason) {
      entry.blocked.unshift({
        url: statusUrl(url), reason, resourceType: String(p.resourceType ?? ''), redirect: Boolean(p.redirectedRequestId),
        page: entry.sessionPage.get(ev.sessionId!) ?? null, at: this.d.now(),
      })
      entry.blocked.length = Math.min(entry.blocked.length, 20)
      await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, ev.sessionId).catch(() => {})
    } else {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, ev.sessionId).catch(() => {})
    }
  }

  /**
   * A WebSocket is NOT interceptable by CDP — measured S2: neither `Fetch` nor `Network.setBlockedURLs`
   * stops the handshake. The real guard is the target's own Origin check (agentistics' WS routes refuse a
   * foreign Origin; Chromium's debug endpoint refuses any page Origin without `--remote-allow-origins`,
   * which we never pass). On top of that, a page that tries one to a blocked address is CLOSED here and
   * the attempt recorded — a reaction, not a prevention: the handshake may already be on the wire.
   */
  private async onWebSocket(entry: Entry, ev: CdpEvent): Promise<void> {
    const url: string = ev.params?.url ?? ''
    const reason = await this.blockReasonFor(url)
    if (!reason) return
    const page = entry.sessionPage.get(ev.sessionId!) ?? null
    entry.blocked.unshift({ url: statusUrl(url.replace(/^ws/i, 'http')), reason, resourceType: 'WebSocket', redirect: false, page, at: this.d.now() })
    entry.blocked.length = Math.min(entry.blocked.length, 20)
    this.log(`${entry.key}: a page opened a WebSocket to a blocked address (${reason}); closing its tab`)
    if (page) await entry.cdp?.send('Target.closeTarget', { targetId: page }).catch(() => {})
  }

  /**
   * S10 r3 F6: a tab the PAGE navigated itself (a followed link) kept the title Chromium reports while a document
   * loads — its URL — because the later title change is not always announced. When the main frame stops loading,
   * ask the page what it is called now (`document.title`), so the tab strip shows the title and the address the URL.
   */
  private async refreshTab(entry: Entry, targetId: string): Promise<void> {
    const sid = entry.tabSessions.get(targetId)
    if (!sid || !entry.cdp) return
    try {
      const r = await entry.cdp.send<{ result?: { value?: { url?: unknown; title?: unknown } } }>('Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true }, sid, 5_000)
      const v = r?.result?.value
      if (!v || typeof v.title !== 'string' || typeof v.url !== 'string') return
      if (!entry.tabs.has(targetId) || entry.doomed.has(targetId) || entry.phase !== 'live') return
      this.upsertTab(entry, { targetId, url: v.url, title: v.title })
    } catch { /* the tab went away or is busy: the next load asks again */ }
  }

  private upsertTab(entry: Entry, t: { targetId: string; url?: string; title?: string }): void {
    const prev = entry.tabs.get(t.targetId)
    entry.tabs.set(t.targetId, {
      targetId: t.targetId, url: t.url ?? prev?.url ?? '', title: t.title ?? prev?.title ?? '',
      lastActiveMs: prev?.lastActiveMs ?? this.d.now(),
    })
  }

  // --------------------------------------------------------------------------------------------- stop

  /** The tab list of a personal browser stopped while minimized (urls only; nothing else of it survives — its profile is disposable). */
  private savedTabs = new Map<string, { urls: string[]; at: number }>()

  /** How many tabs a reopen would restore, or 0. */
  savedTabCount(key: string): number { return this.savedTabs.get(key)?.urls.length ?? 0 }
  forgetSavedTabs(key: string): void { this.savedTabs.delete(key) }

  /** Hide it: Chromium and its tabs stay; from now on it idles out on the minimized clock. False when none is live. */
  minimize(key: string): boolean {
    const e = this.entries.get(key)
    if (!e || e.phase !== 'live' || e.owner.kind !== 'personal') return false
    e.minimizedAt = this.d.now()
    return true
  }

  /**
   * Reopening: bring the browser back — the live one as it was, or (stopped while minimized) a fresh one with the
   * saved tabs reloaded. Nothing there and nothing saved opens `homeUrl`. `restored` is how many tabs came back
   * from the saved list; `home` says the default page was opened.
   */
  async openPersonal(homeUrl: string): Promise<{ ok: true; restored: number; home: boolean; wasStopped: boolean } | { ok: false; reason: string; sentence: string }> {
    const key = 'personal'
    const saved = this.savedTabs.get(key)
    const wasStopped = !this.entries.get(key) || this.entries.get(key)!.phase === 'stopping'
    const started = await this.start({ kind: 'personal' })
    if (!started.ok) return { ok: false, reason: started.reason, sentence: started.sentence }
    const e = this.entries.get(key)
    if (!e) return { ok: false, reason: 'start-failed', sentence: 'The browser could not be started.' }
    e.minimizedAt = null
    e.lastActivityMs = this.d.now()
    // The browser starts with one blank tab. It becomes the default page / the first restored tab, never a
    // stray "New tab" left beside it: the blank ones are closed once a real page is open.
    const blanks = [...e.tabs.values()].filter(t => !t.url || t.url === 'about:blank').map(t => t.targetId)
    let restored = 0
    if (saved) {
      this.savedTabs.delete(key)
      for (const url of saved.urls) {
        const r = await this.openTab(key, url)
        if (r.ok) restored++
      }
    }
    let home = false
    if (restored === 0 && [...e.tabs.values()].every(t => !t.url || t.url === 'about:blank')) {
      const r = await this.openTab(key, homeUrl)
      home = r.ok
    }
    if (restored > 0 || home) {
      for (const id of blanks) {
        if (!e.tabs.has(id) || !e.cdp) continue
        try { await e.cdp.send('Target.closeTarget', { targetId: id }) } catch { /* already gone */ }
        e.tabs.delete(id)
      }
      if (!e.tabs.has(e.activeTab ?? '')) e.activeTab = [...e.tabs.keys()].pop() ?? null
    }
    return { ok: true, restored, home, wasStopped }
  }

  /** Stop one browser by its saved PID and delete its profile. Idempotent; concurrent calls share one stop. */
  stop(key: string, reason: StopReason): Promise<void> {
    const e = this.entries.get(key)
    if (!e) return Promise.resolve()
    if (e.stopping) return e.stopping
    // The person's tab list outlives a minimized browser that was stopped for idleness or memory (or evicted for
    // another browser): reopening restores it. An explicit close forgets it; so does a browser nobody minimized.
    if (e.owner.kind === 'personal') {
      if (e.minimizedAt !== null && (reason === 'idle' || reason === 'memory' || reason === 'evicted')) {
        const urls = [...e.tabs.values()].map(t => t.url).filter(u => u && u !== 'about:blank')
        if (urls.length) this.savedTabs.set(key, { urls, at: this.d.now() })
      } else if (reason === 'requested' || reason === 'crashed' || reason === 'start-failed') this.savedTabs.delete(key)
    }
    e.phase = 'stopping'
    e.stopping = (async () => {
      // The tree is captured BEFORE the kill: Chrome's helpers outlive the main process for a moment and
      // keep writing the profile, so the folder goes only after every one of them is gone.
      const tree = e.child ? this.treeOf(e.child.pid) : []
      e.cdp?.close(reason)
      if (e.child) await this.killPid(e.child)
      await this.waitGone(tree)
      this.removeProfile(e.profileDir)
      if (this.entries.get(key) === e) this.entries.delete(key)
      this.writeRecords()
      this.noteStop(key, reason)
      this.log(`stopped ${key} (${reason})`)
      if (this.entries.size === 0) this.stopTimer()
      e.child = null
      e.cdp = null
      await this.d.settleFds?.()
    })()
    return e.stopping
  }

  /** SIGTERM the saved PID, SIGKILL after the grace period. Never by name. */
  private async killPid(child: SpawnedBrowser): Promise<void> {
    if (child.hasExited()) return
    try { this.d.kill(child.pid, 'SIGTERM') } catch { return }
    const graceful = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
    ])
    if (!graceful && !child.hasExited()) {
      try { this.d.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS))])
    }
  }

  /** The browser's process tree with each member's cmdline at this moment (the identity a late kill
   *  checks again). Empty off Linux. */
  private treeOf(pid: number): Array<{ pid: number; cmd: string | null }> {
    if (!this.d.proc) return []
    return descendants(pid, this.d.proc.ppids()).map(p => ({ pid: p, cmd: this.d.proc!.cmdline(p) }))
  }

  private isGone(pid: number): boolean {
    if (this.d.proc?.gone) return this.d.proc.gone(pid)
    try { this.d.kill(pid, 0); return false } catch (e: any) { return e?.code !== 'EPERM' }
  }

  /** Wait for every member of a captured tree to exit; after the grace period, SIGKILL a straggler
   *  ONLY if it still carries the cmdline it had when captured (a recycled pid is never touched). */
  private async waitGone(tree: Array<{ pid: number; cmd: string | null }>): Promise<void> {
    if (tree.length === 0) return
    const started = Date.now()
    while (tree.some(t => !this.isGone(t.pid)) && Date.now() - started < KILL_GRACE_MS) {
      await new Promise((r) => setTimeout(r, 50))
    }
    for (const t of tree) {
      if (this.isGone(t.pid)) continue
      if (t.cmd !== null && this.d.proc?.cmdline(t.pid) === t.cmd) {
        try { this.d.kill(t.pid, 'SIGKILL') } catch { /* gone */ }
      }
    }
    const after = Date.now()
    while (tree.some(t => !this.isGone(t.pid)) && Date.now() - after < 1000) await new Promise((r) => setTimeout(r, 50))
  }

  /** For `process.on('exit')`, where nothing async runs: SIGKILL every saved PID and drop the profiles.
   *  (In pipe mode the browsers die with our pipe anyway; this is the belt to that brace.) */
  killAllSync(): void {
    // The whole tree, captured with each member's cmdline BEFORE any kill (a helper keeps writing the
    // profile after the main process dies — measured S2: the folder survived a server SIGTERM because the
    // rm ran while a helper still wrote). A member is killed only while it still carries that cmdline.
    const trees = [...this.entries.values()].map(e => ({ e, tree: e.child ? this.treeOf(e.child.pid) : [] }))
    for (const { e, tree } of trees) {
      if (e.child && !e.child.hasExited()) { try { this.d.kill(e.child.pid, 'SIGKILL') } catch { /* gone */ } }
      for (const t of tree) {
        if (t.pid === e.child?.pid || t.cmd === null || this.d.proc?.cmdline(t.pid) !== t.cmd) continue
        try { this.d.kill(t.pid, 'SIGKILL') } catch { /* gone */ }
      }
    }
    // Nothing async runs in an exit handler: a short, bounded busy wait for the trees to go.
    const until = Date.now() + 500
    while (Date.now() < until && trees.some(({ tree }) => tree.some(t => !this.isGone(t.pid)))) { /* spin */ }
    for (const { e } of trees) this.removeProfile(e.profileDir)
    this.entries.clear()
    this.writeRecords()
  }

  async stopAll(reason: StopReason = 'server-stop'): Promise<void> {
    await Promise.all([...this.entries.keys()].map(k => this.stop(k, reason)))
  }

  private noteStop(key: string, reason: StopReason): void {
    this.recentStops.unshift({ key, reason, at: this.d.now() })
    this.recentStops.length = Math.min(this.recentStops.length, 20)
    for (const fn of this.stopListeners) {
      try { fn(key, reason) } catch { /* a listener never breaks a stop */ }
    }
  }

  private stopListeners = new Set<(key: string, reason: StopReason) => void>()
  /** S3: the padlock releases the actions it holds when the browser they wait on stops. */
  onStopped(fn: (key: string, reason: StopReason) => void): () => void {
    this.stopListeners.add(fn)
    return () => { this.stopListeners.delete(fn) }
  }

  // ------------------------------------------------------------------------------------- activity

  /** A model action or a person's interaction on this browser. */
  touch(key: string): void {
    const e = this.entries.get(key)
    if (e) e.lastActivityMs = this.d.now()
  }

  addViewer(key: string): void {
    const e = this.entries.get(key)
    if (e) { e.viewers++; e.lastActivityMs = this.d.now() }
  }

  removeViewer(key: string): void {
    const e = this.entries.get(key)
    if (e && e.viewers > 0) { e.viewers--; e.lastActivityMs = this.d.now() }
  }

  /** The CDP connection of a live browser (S2's actions use it). */
  cdpOf(key: string): CdpClient | null {
    const e = this.entries.get(key)
    return e && e.phase === 'live' ? e.cdp : null
  }

  /**
   * Navigate the active tab (or a new one). Refuses a URL the block rules refuse (spec §4) before the
   * browser is touched; a redirect to one is refused by the interception. Kept for S1 callers; the
   * routes go through `runAction`.
   */
  async navigate(key: string, url: string): Promise<{ ok: true; targetId: string; url: string; title: string } | { ok: false; reason: string }> {
    const h = this.actionHost(key)
    if (!h) return { ok: false, reason: 'no-browser' }
    const blocked = await this.blockReasonFor(url)
    if (blocked) return { ok: false, reason: `blocked:${blocked}` }
    const { runAction } = await import('./browser-actions')
    const r = await runAction(h, { action: 'navigate', url })
    if (!r.ok) return { ok: false, reason: r.error === 'blocked' ? `blocked:${(r as any).reason}` : `navigation:${r.sentence}` }
    return { ok: true, targetId: String(r.tab), url: String(r.url), title: String(r.title) }
  }

  /** Open another tab, within the per-owner tab ceiling. */
  async openTab(key: string, url = 'about:blank'): Promise<{ ok: true; targetId: string } | { ok: false; reason: string }> {
    const e = this.entries.get(key)
    if (!e || e.phase !== 'live' || !e.cdp) return { ok: false, reason: 'no-browser' }
    const max = e.owner.kind === 'personal' ? MAX_TABS_PERSONAL : MAX_TABS_SESSION
    if (e.tabs.size >= max) return { ok: false, reason: 'tab-ceiling' }
    const blocked = await this.blockReasonFor(url)
    if (blocked) return { ok: false, reason: `blocked:${blocked}` }
    const { targetId } = await e.cdp.send<{ targetId: string }>('Target.createTarget', { url })
    this.upsertTab(e, { targetId, url })
    e.activeTab = targetId
    e.lastActivityMs = this.d.now()
    return { ok: true, targetId }
  }

  /** What `runAction` drives: one live browser, seen through a narrow interface. Null when not live. */
  actionHost(key: string): ActionHost | null {
    const e = this.entries.get(key)
    if (!e || e.phase !== 'live' || !e.cdp) return null
    const cdp = e.cdp
    const host = this
    return {
      cdp,
      ownerKind: e.owner.kind,
      maxTabs: e.owner.kind === 'personal' ? MAX_TABS_PERSONAL : MAX_TABS_SESSION,
      tabs: () => [...e.tabs.values()].map(t => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.targetId === e.activeTab })),
      activeTab: () => (e.activeTab && e.tabs.has(e.activeTab) ? e.activeTab : null),
      setActive: (targetId) => {
        if (!e.tabs.has(targetId)) return
        e.activeTab = targetId
        const t = e.tabs.get(targetId)!
        t.lastActiveMs = host.d.now()
      },
      noteTab: (targetId, url, title) => {
        const t = e.tabs.get(targetId)
        if (t) { t.url = url; t.title = title; t.lastActiveMs = host.d.now() }
      },
      sessionFor: async (targetId) => {
        const known = e.tabSessions.get(targetId)
        if (known) return known
        // Not auto-attached (yet): attach explicitly and intercept before anything else is sent.
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
        if (!e.tabSessions.has(targetId)) {
          await host.setupAttached(e, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { targetId, type: 'page' }, waitingForDebugger: false } })
        }
        return e.tabSessions.get(targetId) ?? sessionId
      },
      waitTab: async (targetId, ms) => {
        const started = Date.now()
        while (!e.tabSessions.has(targetId) && Date.now() - started < ms) await new Promise(r => setTimeout(r, 25))
      },
      blockedSince: (ms) => e.blocked.filter(b => b.at >= ms),
      blockReason: (url) => host.blockReasonFor(url),
      noteAction: (a) => { e.lastAction = a },
      touch: () => { e.lastActivityMs = host.d.now() },
      now: () => host.d.now(),
    }
  }

  // ----------------------------------------------------------------------------------- the watcher

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, WATCH_INTERVAL_MS)
    ;(this.timer as any).unref?.()
  }
  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** One watcher pass: session ended → stop; idle → stop; memory → trim or stop. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.d.now()
      const ppids = this.d.proc?.ppids() ?? null
      for (const e of [...this.entries.values()]) {
        if (e.phase !== 'live') continue
        if (e.owner.kind === 'session' && this.d.sessionLive?.(e.owner.managedId) === false) {
          await this.stop(e.key, 'session-ended')
          continue
        }
        if (idleExpired({ owner: e.owner, viewers: e.viewers, lastActivityMs: e.lastActivityMs, minimizedAt: e.minimizedAt, now })) {
          await this.stop(e.key, 'idle')
          continue
        }
        if (ppids && e.pid !== null) {
          const verdict = memoryVerdict(this.treeMemory(e.pid, ppids))
          e.memory = verdict
          if (verdict.action === 'kill') {
            this.log(`${e.key} over the memory ceiling (${verdict.basis} ${verdict.bytes}); stopping`)
            await this.stop(e.key, 'memory')
          } else if (verdict.action === 'trim') {
            const victim = tabToTrim([...e.tabs.values()], e.activeTab)
            if (victim && e.cdp) await e.cdp.send('Target.closeTarget', { targetId: victim }).catch(() => {})
          }
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** PSS and RSS of a browser's whole process tree. PSS is null if ANY member's smaps_rollup was unreadable
   *  (a partial PSS would under-count and read safe). */
  private treeMemory(pid: number, ppids: Map<number, number>): { pss: number | null; rss: number | null } {
    let pss = 0, rss = 0, pssOk = true, any = false
    for (const p of descendants(pid, ppids)) {
      const text = this.d.proc?.smapsRollup(p) ?? null
      if (!text) { pssOk = false; continue }
      const r = parseSmapsRollup(text)
      if (r.pss === null) pssOk = false; else pss += r.pss
      if (r.rss !== null) { rss += r.rss; any = true }
    }
    return { pss: pssOk && any ? pss : null, rss: any ? rss : null }
  }

  private profileDirs(): string[] {
    const dirs: string[] = []
    try { for (const n of readdirSync(join(this.d.root, 'sessions'))) dirs.push(join(this.d.root, 'sessions', n)) } catch { /* none */ }
    if (existsSync(join(this.d.root, 'personal'))) dirs.push(join(this.d.root, 'personal'))
    return dirs
  }

  /**
   * S12 — "Delete profiles": remove every profile folder (cookies, caches). REFUSED while any browser is
   * live or starting — a profile a running Chromium holds is not ours to pull — and says so in words.
   */
  deleteProfiles(): { ok: true; removed: number } | { ok: false; error: 'browser_live'; live: number; sentence: string } {
    const live = this.entries.size
    if (live > 0) {
      return { ok: false, error: 'browser_live', live, sentence: 'A browser is open right now. Close it (or wait for it to close) before deleting profiles.' }
    }
    const dirs = this.profileDirs()
    for (const dir of dirs) this.removeProfile(dir)
    return { ok: true, removed: dirs.length }
  }

  // ------------------------------------------------------------------------------- the orphan sweep

  /** Stop recorded browsers no live host owns (by saved PID, identity checked) and delete every profile
   *  folder no live browser holds. Run on boot; safe to run at any time (this host's own live browsers
   *  are protected). */
  async sweep(): Promise<SweepPlan> {
    const records = this.readRecords()
    const dirs: string[] = []
    try { for (const n of readdirSync(join(this.d.root, 'sessions'))) dirs.push(join(this.d.root, 'sessions', n)) } catch { /* none */ }
    if (existsSync(join(this.d.root, 'personal'))) dirs.push(join(this.d.root, 'personal'))
    const plan = planOrphanSweep({
      root: this.d.root, records, dirs, selfPid: this.d.selfPid,
      ownLiveDirs: new Set([...this.entries.values()].map(e => e.profileDir)),
      alive: (pid) => { try { this.d.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } },
      cmdline: (pid) => this.d.proc?.cmdline(pid) ?? null,
      startTime: (pid) => this.d.proc?.startTime?.(pid) ?? null,
    })
    // S1 QA reservation b: a live browser of ours that NO record names (pids.json deleted/corrupt) and
    // whose host is gone. Its own argv naming our profile folder is the identity.
    if (this.d.proc) {
      const protectedDirs = new Set<string>([...this.entries.values()].map(e => e.profileDir))
      for (const r of records) if (plan.keptForOtherHost.includes(r.key)) protectedDirs.add(r.profileDir)
      const ppids = this.d.proc.ppids()
      const procs = [...ppids].map(([pid, ppid]) => ({ pid, ppid, cmd: this.d.proc!.cmdline(pid) }))
      const extra = planUnrecordedOrphans({
        root: this.d.root, procs, selfPid: this.d.selfPid, protectedDirs, alreadyKilling: new Set(plan.kill.map(k => k.pid)),
      })
      for (const k of extra.kill) {
        plan.kill.push({ pid: k.pid, key: `unrecorded:${k.dir.slice(this.d.root.length + 1)}` })
        if (!plan.removeDirs.includes(k.dir) && !protectedDirs.has(k.dir)) plan.removeDirs.push(k.dir)
      }
    }
    const trees = plan.kill.map(k => this.treeOf(k.pid))
    for (const k of plan.kill) {
      try { this.d.kill(k.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    for (const t of trees) await this.waitGone(t)
    for (const dir of plan.removeDirs) this.removeProfile(dir)
    if (plan.dropKeys.length) {
      const keep = records.filter(r => !plan.dropKeys.includes(r.key) || this.entries.has(r.key))
      this.writeRecordList(keep)
    }
    this.lastSweep = { at: this.d.now(), killed: plan.kill.length, removedDirs: plan.removeDirs.length, keptForOtherHost: plan.keptForOtherHost.length }
    if (plan.kill.length || plan.removeDirs.length) this.log(`sweep: killed ${plan.kill.length}, removed ${plan.removeDirs.length} folder(s)`)
    return plan
  }

  // ---------------------------------------------------------------------------------- status

  async status(): Promise<BrowserStatus> {
    const bin = this.d.bin()
    const mem = await this.d.memAvailable()
    return {
      executable: { ...bin, sentence: browserBinSentence(bin) },
      live: [...this.entries.values()].map(e => this.summary(e)),
      ceilings: { live: MAX_LIVE_BROWSERS, session: MAX_SESSION_BROWSERS, personal: MAX_PERSONAL_BROWSERS, tabsSession: MAX_TABS_SESSION, tabsPersonal: MAX_TABS_PERSONAL },
      memory: { available: mem, minAvailable: MIN_AVAILABLE_BYTES, measured: mem !== null, trimBytes: PSS_TRIM_BYTES, killBytes: PSS_KILL_BYTES, rssFallbackFactor: RSS_FALLBACK_FACTOR },
      profiles: { count: this.profileDirs().length },
      scope: { available: this.scopeOk() },
      recentStops: [...this.recentStops],
      personalSaved: this.savedTabs.has('personal') ? { tabs: this.savedTabCount('personal') } : null,
      lastSweep: this.lastSweep,
    }
  }

  private summary(e: Entry): BrowserSummary {
    return {
      key: e.key, owner: e.owner, phase: e.phase, pid: e.pid, startedAt: e.startedAt,
      lastActivityMs: e.lastActivityMs, viewers: e.viewers, minimized: e.minimizedAt !== null,
      // S1 QA reservation c: status is a summary — origin+path, `data:` reduced to its type, a clean title.
      tabs: [...e.tabs.values()].map(t => ({ targetId: t.targetId, url: statusUrl(t.url), title: statusTitle(t.title), active: t.targetId === e.activeTab })),
      blocked: e.blocked.slice(0, 5).map(b => ({ url: b.url, reason: b.reason, resourceType: b.resourceType, redirect: b.redirect, at: b.at })),
      lastAction: e.lastAction ? { kind: e.lastAction.kind, label: statusLabel(e.lastAction.label), at: e.lastAction.at } : null,
      memory: e.memory ? { basis: e.memory.basis, bytes: e.memory.bytes, action: e.memory.action } : null,
      scope: e.scope, scopeEscaped: e.scopeEscaped, sandbox: e.sandbox,
    }
  }

  private views(): LiveBrowserView[] {
    return [...this.entries.values()]
      .filter(e => e.phase !== 'stopping')
      .map(e => ({ key: e.key, owner: e.owner, phase: e.phase === 'live' ? 'live' : 'starting', viewers: e.viewers, lastActivityMs: e.lastActivityMs, minimized: e.minimizedAt !== null }))
  }

  private scopeOk(): boolean {
    if (this.scopeAvailable === null) this.scopeAvailable = this.d.scopeWorks()
    return this.scopeAvailable
  }

  // ------------------------------------------------------------------------- profiles and records

  private prepareProfile(dir: string): void {
    mkdirSync(this.d.root, { recursive: true, mode: 0o700 })
    this.removeProfile(dir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch { /* best effort */ }
  }

  private removeProfile(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch (e) { this.log(`could not remove ${dir}: ${String(e)}`) }
  }

  private recordsPath(): string { return join(this.d.root, 'pids.json') }

  private selfStartMemo: { hostStart?: number } | null = null
  /** This host's own start time, written into every record so a recycled host pid is told apart. */
  private selfStart(): { hostStart?: number } {
    if (!this.selfStartMemo) {
      const v = this.d.proc?.startTime?.(this.d.selfPid) ?? null
      this.selfStartMemo = v === null ? {} : { hostStart: v }
    }
    return this.selfStartMemo
  }

  private readRecords(): PidRecord[] {
    try {
      const raw = JSON.parse(readFileSync(this.recordsPath(), 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.filter((r: any) => r && typeof r.key === 'string' && Number.isInteger(r.pid) && r.pid > 1
        && typeof r.profileDir === 'string' && Number.isInteger(r.hostPid)
        && (r.hostStart === undefined || Number.isInteger(r.hostStart)))
    } catch { return [] }
  }

  /** This host's live/starting browsers, plus records owned by OTHER live hosts (left as they were). */
  private writeRecords(): void {
    const mine: PidRecord[] = [...this.entries.values()]
      .filter(e => e.pid !== null && e.phase !== 'stopping')
      .map(e => ({ key: e.key, pid: e.pid!, profileDir: e.profileDir, hostPid: this.d.selfPid, ...this.selfStart(), startedAt: e.startedAt }))
    const others = this.readRecords().filter(r => r.hostPid !== this.d.selfPid)
    this.writeRecordList([...others, ...mine])
  }

  private writeRecordList(list: PidRecord[]): void {
    try {
      mkdirSync(this.d.root, { recursive: true, mode: 0o700 })
      const tmp = `${this.recordsPath()}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 })
      renameSync(tmp, this.recordsPath())
    } catch (e) { this.log(`could not write pids.json: ${String(e)}`) }
  }
}

// ---------------------------------------------------------------------------------------------------
// Real dependencies

export const linuxProc: ProcReader = {
  ppids: () => {
    const m = new Map<number, number>()
    let names: string[] = []
    try { names = readdirSync('/proc') } catch { return m }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue
      try {
        const pp = ppidFromStat(readFileSync(`/proc/${n}/stat`, 'utf8'))
        if (pp !== null) m.set(Number(n), pp)
      } catch { /* gone */ }
    }
    return m
  },
  smapsRollup: (pid) => { try { return readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8') } catch { return null } },
  cmdline: (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return null } },
  cgroup: (pid) => { try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8') } catch { return null } },
  startTime: (pid) => { try { return startTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null } },
  gone: (pid) => {
    try {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) === 'Z'
    } catch { return true }
  },
}

/** `node:child_process.spawn` with CDP on fds 3/4 (probe P1 — `Bun.spawn` cannot carry them). */
export function spawnWithPipe(bin: string, argv: string[]): SpawnedBrowser {
  const cp: ChildProcess = nodeSpawn(bin, argv, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: false })
  if (typeof cp.pid !== 'number') throw new Error('spawn returned no pid')
  let exited = false
  let info = ''
  const exitedP = new Promise<void>((res) => {
    cp.once('exit', (code, signal) => {
      info = `code=${code} signal=${signal}`; exited = true
      res()
    })
    cp.once('error', () => { exited = true; res() })
  })
  return {
    pid: cp.pid,
    exited: exitedP,
    hasExited: () => exited,
    exitInfo: () => info,
    cdpOut: cp.stdio[3] as Writable,
    cdpIn: cp.stdio[4] as Readable,
  }
}

/** Does `systemd-run --user --scope` work here, with the swap cap? Off by `AGENTISTICS_BROWSER_SCOPE=0`. */
export function probeScope(env: Record<string, string | undefined> = process.env): boolean {
  if (process.platform !== 'linux' || env.AGENTISTICS_BROWSER_SCOPE === '0') return false
  try {
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '--', 'true'],
      { stdio: 'ignore', timeout: 5_000 })
    return r.status === 0
  } catch { return false }
}

/** A forced GC, with a turn of the event loop either side so closed handles are unreachable and finalized. */
export async function settleFds(): Promise<void> {
  const gc = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc
  if (!gc) return
  await new Promise<void>(r => setTimeout(r, 30))
  try { gc(true) } catch { /* best effort */ }
  await new Promise<void>(r => setTimeout(r, 30))
}

/** The host wired to the real machine. */
export function createBrowserHost(opts: {
  dataDir: string
  agentisticsPorts: readonly number[]
  memAvailable: () => Promise<number | null>
  sessionLive?: (managedId: string) => boolean | undefined
  /** Overrides for tests: the neighbour debug ports and the DNS the block rules use. */
  debugPorts?: () => readonly number[]
  resolve?: (hostname: string) => Promise<string[]>
  log?: (line: string) => void
}): BrowserHost {
  return new BrowserHost({
    root: join(opts.dataDir, 'browser'),
    bin: () => findBrowserBin(),
    memAvailable: opts.memAvailable,
    now: () => Date.now(),
    spawn: spawnWithPipe,
    kill: (pid, sig) => { process.kill(pid, sig) },
    settleFds,
    proc: process.platform === 'linux' ? linuxProc : null,
    scopeWorks: () => probeScope(),
    agentisticsPorts: opts.agentisticsPorts,
    sessionLive: opts.sessionLive,
    selfPid: process.pid,
    forceNoSandbox: process.env.AGENTISTICS_BROWSER_NO_SANDBOX === '1',
    resolve: opts.resolve ?? (async (hostname) => (await dnsLookup(hostname, { all: true })).map(a => a.address)),
    debugPorts: opts.debugPorts,
    selfAddresses: () => Object.values(networkInterfaces()).flat().filter(Boolean).map(a => a!.address),
    log: opts.log,
  })
}
