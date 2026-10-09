/**
 * structured-backend.ts — F2.0: ONE structured-session backend for every harness, as a COMPOSITE
 * `SessionBackend` over tmux. It generalises A5.4's `acp-backend.ts` (which is now this module with the
 * flag off and nothing but ACP).
 *
 * Routing (`structured-route.ts`, pure):
 * - a WEB-born spawn, flag `adapter-chat` ON, a READY driver for the harness (`Engine.structured`, or a
 *   1.9 engine's `Engine.acp` adapted) → started over the harness's protocol;
 * - A5.4's opt-in (`preferences.acpHarnesses` + `Engine.acp`) → exactly as before;
 * - everything else → tmux, the same request, byte for byte.
 *
 * Fallback, both ends: a structured start that is refused goes to tmux with the SAME request; a
 * structured session whose driver FAILS mid-life (`onExit({kind:'failed'})`) is resumed in tmux by its
 * conversation id under the SAME managed id (`provider.resumeSpawn`), so the row continues as a TUI.
 *
 * What each verb means for a structured session:
 * - `capture` / `captureTerminal` — the driver's rendered view (never journaled);
 * - `sendText` — the next prompt; `sendKey('<digit>')` / `sendChoiceText` / `answer` — the open
 *   request, answered THROUGH THE DRIVER (no keystroke reaches anything); `Escape` / `C-c` — cancel;
 * - `activityOf` / `dialogOf` / `attentionOf` — what the protocol states;
 * - `chatOf` — the session's own chat channel (turns, `live` text, `state`) for the adapter chat stream;
 * - `kill` — end it; `attachCommand` — no terminal to attach to, said in a sentence.
 */
import type {
  EngineAcp, EngineAcpSession, EngineStructured, HarnessChat, HarnessChatDelta, HarnessId,
  StructuredAnswer, StructuredAttention, StructuredDeclaration, StructuredDriverId, StructuredExit,
  StructuredSession, StructuredSpawn, StructuredStart,
} from '@agentistics/engine-api'
import { answerFits } from '@agentistics/engine-api'
import { SPAWN_SPECS } from './spawn-spec'
import type { DurableStore, DurableTransport, SavedSpawn } from './structured-durable'
import { routeSpawn, type SpawnRoute } from './structured-route'
import type { BackendSession, BackendSpawn, SessionActivity, SessionBackend, TerminalCapture } from './types'

/** Which harness an argv starts — by its binary's base name against the spawn specs. */
export function harnessOfArgv(argv: readonly string[]): HarnessId | null {
  const bin = (argv[0] ?? '').split(/[\\/]/).pop() ?? ''
  for (const [h, spec] of Object.entries(SPAWN_SPECS)) if (spec && spec.bin === bin) return h as HarnessId
  return null
}

export interface StructuredProvider {
  /** `Engine.structured` (1.10), or null. */
  structured(): Promise<EngineStructured | null>
  /** `Engine.acp` (1.7), or null — A5.4's opt-in path, and a 1.9 engine's only structured driver. */
  acp(): Promise<EngineAcp | null>
  /** `preferences.acpHarnesses`, read fresh each spawn. */
  allowed(): Promise<readonly string[]>
  /** `featureOn('adapter-chat')`, read each spawn. Absent = off. */
  flagOn?(): boolean
  /** The tmux spawn that resumes `conversationId` under the same managed id; null = no resume possible. */
  resumeSpawn?(req: BackendSpawn, conversationId: string): Promise<BackendSpawn | null>
  /** The protocol stated the conversation id (once per session). */
  onConversation?(id: string, conversationId: string): void
  /** A session is now hosted over its protocol (route `structured` only). */
  onStarted?(id: string, driver: StructuredDriverId): void
  /** A structured session fell back to tmux (or could not), for the log / the row's note. */
  onFallback?(id: string, outcome: { reason: string; resumed: boolean }): void
  /**
   * F3.3 — before a structured start: what the tmux backend does before every pane (the session-identity
   * key the agentistics MCP proves its session with, `session-identity.ts`). Absent = nothing.
   */
  prepare?(): Promise<void>
  /**
   * F2.0b — where a structured child lives so it SURVIVES the server (`structured-durable.ts`). Absent:
   * the driver spawns its child itself and it dies with this process (F2.0's behaviour).
   */
  durable?: DurableStore
  /** F2.0b — the conversation a row is linked to, from the registry (for a session this process does not drive). */
  conversationOf?(id: string): Promise<string | null>
  /** F2.0b — a session was re-attached after a restart (or could not be), for the log. */
  onReattach?(id: string, outcome: { ok: true } | { ok: false; reason: string; resumed: boolean }): void
}

/** F2.0b — what `toTerminal` did. */
export type ToTerminalOutcome =
  | { ok: true }
  | { ok: false; why: 'not-structured' | 'no-conversation' | 'no-resume' | 'still-running' | 'spawn-failed' }

/**
 * F2.0b — the session as the host drives it, with every call RECORDED (`calls.jsonl`) so a re-attach
 * can make the same calls on a re-created driver. A call is recorded after it returns: its writes are
 * then queued, not yet sent, so the record is on disk before the bytes leave this process.
 */
export function recordingSession(s: StructuredSession, t: Pick<DurableTransport, 'record'>): StructuredSession {
  return {
    id: s.id, driver: s.driver, harness: s.harness,
    conversationId: () => s.conversationId(),
    activity: () => s.activity(),
    attention: () => s.attention(),
    screen: n => s.screen(n),
    lastActivityMs: () => s.lastActivityMs(),
    prompt(text) { const ok = s.prompt(text); if (ok) t.record({ op: 'prompt', text }); return ok },
    answer(a) {
      const ok = s.answer(a)
      if (ok) t.record({ op: 'answer', ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.text !== undefined ? { text: a.text } : {}), ...(a.requestId !== undefined ? { requestId: a.requestId } : {}) })
      return ok
    },
    cancel() { s.cancel(); t.record({ op: 'cancel' }) },
    follow: (max, on) => s.follow(max, on),
    onExit: cb => s.onExit(cb),
    dispose: () => s.dispose(),
  }
}

const toActivity = (a: string): SessionActivity => (a === 'starting' ? 'working' : a as SessionActivity)

const LEGACY_ATTACH = 'This session is driven over ACP: there is no terminal to attach to. Use the fleet to prompt it.'
const STRUCTURED_ATTACH = 'This session is driven over its harness\'s protocol: there is no terminal to attach to. Use the fleet to prompt it, or open it in a terminal (a resume of the same conversation).'

const ACP_ABSENT = (h: string) => `the 1.9 engine drives ${h} over ACP without stating this`
/** What a 1.9 engine's bare ACP handle can say, honestly: little beyond prompt / answer / cancel. */
export function acpLegacyDeclaration(h: HarnessId): StructuredDeclaration {
  const no = { absent: ACP_ABSENT(h) }
  return {
    assignId: no, resume: no, model: no, effort: no, mcp: no,
    instructions: { channel: 'first-message', reason: `the 1.9 ACP handle takes no context field for ${h}` },
    live: no, permissions: { via: 'ACP session/request_permission' }, questions: no, cancel: { via: 'ACP session/cancel' },
  }
}

/**
 * A 1.7–1.9 engine's `EngineAcpSession` as a `StructuredSession`. `conversationId` stays null (that
 * handle never said which store id it was), so nothing is ever recorded from it; `follow` states the
 * session's state only (no turns: the files remain the source of those for a 1.9 engine).
 */
export function acpSessionAsStructured(s: EngineAcpSession, harness: HarnessId, pollMs = 500): StructuredSession {
  const attention = (): StructuredAttention | null => {
    const d = s.dialog()
    return d ? { requestId: 'acp', kind: 'permission', options: d.options.map((label, i) => ({ id: String(i + 1), label })) } : null
  }
  const exitCbs = new Set<(e: StructuredExit) => void>()
  let exitTimer: ReturnType<typeof setInterval> | null = null
  let exited = false
  const fireExit = (e: StructuredExit) => { if (exited) return; exited = true; if (exitTimer) clearInterval(exitTimer); for (const cb of exitCbs) cb(e) }
  return {
    id: s.id, driver: 'acp', harness,
    conversationId: () => null,
    activity: () => s.activity(),
    attention,
    screen: n => s.screen(n),
    lastActivityMs: () => s.lastActivityMs(),
    prompt: t => s.prompt(t),
    answer(a) {
      const fit = answerFits(attention(), a)
      if (!fit.ok || a.choice === undefined || a.text !== undefined) return false
      return s.answer(a.choice)
    },
    cancel: () => s.cancel(),
    follow(_max, on) {
      let last = ''
      const tick = () => {
        const working = s.activity() === 'working' || s.activity() === 'starting'
        const att = attention()
        const key = `${working}|${att ? att.options.join('\u0000') : ''}`
        if (key === last) return
        last = key
        on({ kind: 'state', working, ...(att ? { attention: { kind: 'permission', options: att.options.map(o => o.label) } } : {}) })
      }
      on({ kind: 'window', turns: [], older: false })
      tick()
      const t = setInterval(tick, pollMs) as { unref?: () => void }
      t.unref?.()
      return () => clearInterval(t as ReturnType<typeof setInterval>)
    },
    onExit(cb) {
      exitCbs.add(cb)
      if (!exitTimer && !exited) {
        exitTimer = setInterval(() => { if (s.activity() === 'exited') fireExit({ kind: 'ended' }) }, pollMs)
        ;(exitTimer as { unref?: () => void }).unref?.()
      }
      return () => { exitCbs.delete(cb) }
    },
    dispose() { s.dispose(); fireExit({ kind: 'disposed' }) },
  }
}

/** Held in a constant: `chatNote.test.ts` greps server sources for chat-note literals of this shape. */
const LEGACY_DRIVER_NOTE = 'engine 1.7–1.9 ACP handle'

/** A 1.9 engine's `Engine.acp` as the structured registry the composite asks. */
export function acpAsStructured(acp: EngineAcp): EngineStructured {
  const has = (h: HarnessId) => acp.harnesses().includes(h)
  return {
    drivers: () => [{ id: 'acp', status: 'ready', harnesses: acp.harnesses(), note: LEGACY_DRIVER_NOTE }],
    driverFor: h => (has(h) ? 'acp' : null),
    declares: h => (has(h) ? acpLegacyDeclaration(h) : null),
    async start(req): Promise<StructuredStart> {
      if (!has(req.harness)) return { ok: false, reason: `${req.harness} is not driven over ACP here.` }
      const first = req.instructions && !req.resumeId
        ? [req.instructions.block, req.initialPrompt].filter(Boolean).join('\n\n')
        : req.initialPrompt
      const r = await acp.start({ id: req.id, harness: req.harness, cwd: req.cwd, ...(first ? { initialPrompt: first } : {}) }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'start failed' }))
      return r.ok ? { ok: true, session: acpSessionAsStructured(r.session, req.harness) } : r
    },
  }
}

/**
 * The variable every session agentop starts carries — `session-identity.ts`'s `SESSION_ID_ENV`, named
 * here (not imported: that module reads the data dir at import). The tmux backend sets it on the pane;
 * a structured child gets it the same way, so the agentistics MCP it starts proves the same session
 * (F3.3, measured: an MCP started by `claude -p` saw the variable its parent was given through env(1)).
 */
export const STRUCTURED_SESSION_ENV = 'AGENTOP_MANAGED_ID'

/** PURE. The driver request for a spawn routed `structured`. */
export function structuredSpawnOf(req: BackendSpawn, harness: HarnessId): StructuredSpawn {
  const i = req.structured
  const prompt = i ? i.prompt : req.initialPrompt?.text
  return {
    id: req.id, harness, cwd: req.cwd,
    ...(i?.model ? { model: i.model } : {}),
    ...(i?.effort ? { effort: i.effort } : {}),
    ...(i?.conversationId && !i.resumeId ? { conversationId: i.conversationId } : {}),
    ...(i?.resumeId ? { resumeId: i.resumeId } : {}),
    ...(prompt ? { initialPrompt: prompt } : {}),
    ...(i?.instructions && !i.resumeId ? { instructions: i.instructions } : {}),
    ...(i?.mcp?.length ? { mcp: i.mcp } : {}),
    env: { [STRUCTURED_SESSION_ENV]: req.id, ...(req.env ?? {}) },
  }
}

/** PURE. What a re-attach needs to start the same driver again (no transport, no secret). */
export function savedOf(req: BackendSpawn, harness: HarnessId, spawn: StructuredSpawn): SavedSpawn {
  const { transport: _t, ...rest } = spawn
  return {
    v: 1, harness, spawn: rest,
    backend: { id: req.id, cwd: req.cwd, ...(req.env ? { env: req.env } : {}), ...(req.structured ? { structured: req.structured } : {}) },
  }
}

/** A structured session's own chat channel: resolve is the session itself, follow is the protocol's. */
function sessionChat(s: StructuredSession, declares: StructuredDeclaration | null): HarnessChat {
  const feat = (from: string | undefined, absent: string) => (from ? { from } : { absent })
  return {
    declares: {
      state: { from: `${s.driver} protocol` },
      attention: feat(declares?.permissions.via ?? declares?.questions.via, `${s.driver} states no requests for ${s.harness}`),
      live: feat(declares?.live.via, `${s.driver} streams no text for ${s.harness}`),
      fork: { absent: 'a structured session is its own source' },
    },
    resolve: async () => ({ harness: s.harness, conversationId: s.conversationId() ?? s.id, sourceRef: `structured:${s.driver}:${s.id}` }),
    follow: (_src, max, on: (d: HarnessChatDelta) => void) => s.follow(max, on),
  }
}

interface Live {
  s: StructuredSession
  route: Exclude<SpawnRoute, 'tmux'>
  createdMs: number
  req: BackendSpawn
  declares: StructuredDeclaration | null
  reported: boolean
  off: () => void
}

export type StructuredBackend = SessionBackend & {
  /** Managed ids hosted structurally, with their route. */
  structuredSessions(): Array<{ id: string; route: Exclude<SpawnRoute, 'tmux'>; driver: StructuredDriverId }>
  /**
   * F2.0b — take back every structured session whose child outlived the previous server: replay its
   * record into a re-created driver, then continue live. Called ONCE, by the process that owns the
   * sessions (`agentop server`); `list()` waits for it, so no poll reads such a row as `lost` meanwhile.
   */
  reattach(): Promise<void>
  /**
   * F2.0b — "open in terminal" on a LIVE structured session: end its child cleanly, then resume the
   * SAME conversation as a TUI in tmux under the SAME managed id. Works from any process (a session
   * this process does not drive is ended through its relay). A web reopen later runs structured again.
   */
  toTerminal(id: string): Promise<ToTerminalOutcome>
}

export function withStructured(base: SessionBackend, provider: StructuredProvider): StructuredBackend {
  const live = new Map<string, Live>()
  const of = (id: string) => live.get(id)?.s
  const structuredOnly = (id: string) => { const l = live.get(id); return l && l.route === 'structured' ? l : undefined }

  const report = (id: string, l: Live) => {
    if (l.reported) return
    const c = l.s.conversationId()
    if (!c) return
    l.reported = true
    provider.onConversation?.(id, c)
  }

  const durable = provider.durable
  /** Ended ON PURPOSE (a kill, "open in terminal" — from any process): its exit is not a failure. */
  const endedOnPurpose = (id: string) => !!durable && (durable.ending(id) !== null || durable.saved(id) === null)

  const fallBack = async (id: string, req: BackendSpawn, conv: string | null, reason: string): Promise<boolean> => {
    const resume = conv && provider.resumeSpawn ? await provider.resumeSpawn(req, conv).catch(() => null) : null
    let resumed = false
    if (resume) resumed = await base.spawn({ ...resume, id }).then(() => true, () => false)
    provider.onFallback?.(id, { reason, resumed })
    return resumed
  }

  const onExit = (id: string, l: Live) => async (e: StructuredExit) => {
    if (live.get(id) !== l) return
    if (e.kind !== 'failed') {
      if (durable && l.route === 'structured') { live.delete(id); l.off(); durable.remove(id) }
      return
    }
    live.delete(id)
    l.off()
    if (durable && l.route === 'structured') {
      const purposeful = endedOnPurpose(id)
      durable.remove(id)
      if (purposeful) return
    }
    const conv = l.s.conversationId() ?? l.req.structured?.resumeId ?? l.req.structured?.conversationId ?? null
    await fallBack(id, l.req, conv, e.reason)
  }

  async function startVia(req: BackendSpawn, route: Exclude<SpawnRoute, 'tmux'>, harness: HarnessId, reg: EngineStructured, acp: EngineAcp | null): Promise<boolean> {
    if (route === 'structured') await provider.prepare?.().catch(() => {})
    // F2.0b — a structured child is launched through a relay that outlives this process.
    const sspawn = route === 'structured' ? structuredSpawnOf(req, harness) : null
    const transport: DurableTransport | null = sspawn && durable
      ? durable.create(req.id, savedOf(req, harness, sspawn))
      : null
    const r: StructuredStart = route === 'structured'
      ? await reg.start({ ...sspawn!, ...(transport ? { transport } : {}) }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'start failed' }))
      // A5.4, exactly as before: id, harness, cwd and the initial prompt's text.
      : await acp!.start({ id: req.id, harness, cwd: req.cwd, ...(req.initialPrompt ? { initialPrompt: req.initialPrompt.text } : {}) })
        .then(x => (x.ok ? { ok: true as const, session: acpSessionAsStructured(x.session, harness) } : x), () => ({ ok: false as const, reason: 'start failed' }))
    if (!r.ok) {
      // A relay may have started before the refusal: end it, and leave nothing on disk.
      if (transport && durable) { durable.markEnding(req.id, 'refused'); await durable.terminate(req.id).catch(() => false); durable.remove(req.id) }
      return false
    }
    const session = transport ? recordingSession(r.session, transport) : r.session
    const l: Live = { s: session, route, createdMs: Date.now(), req, declares: route === 'structured' ? reg.declares(harness) : null, reported: false, off: () => {} }
    live.set(req.id, l)
    l.off = r.session.onExit(e => { void onExit(req.id, l)(e) })
    if (route === 'structured') { provider.onStarted?.(req.id, r.session.driver); report(req.id, l) }
    return true
  }

  /** One re-attach per process; `list()` waits on it. */
  let reattaching: Promise<void> | null = null

  async function reattachOne(id: string, reg: EngineStructured | null): Promise<void> {
    if (!durable || live.has(id)) return
    const saved = durable.saved(id)
    const rt = durable.replay(id)
    const req: BackendSpawn = saved
      ? { id, cwd: saved.backend.cwd, argv: [], ...(saved.backend.env ? { env: saved.backend.env } : {}), ...(saved.backend.structured ? { structured: saved.backend.structured as BackendSpawn['structured'] } : {}) }
      : { id, cwd: '', argv: [] }
    const giveUp = async (reason: string, s?: StructuredSession) => {
      durable.markEnding(id, 'reattach-failed')
      s?.dispose()
      await durable.terminate(id).catch(() => false)
      durable.remove(id)
      const conv = (await provider.conversationOf?.(id).catch(() => null)) ?? saved?.spawn.resumeId ?? null
      const resumed = saved ? await fallBack(id, req, conv, reason).catch(() => false) : false
      provider.onReattach?.(id, { ok: false, reason, resumed })
    }
    if (!saved || !rt || !reg) { await giveUp(!reg ? 'no structured driver in this build' : 'nothing to re-attach to'); return }
    const r = await reg.start({ ...saved.spawn, transport: rt }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'start failed' }))
    if (!r.ok) { await giveUp(r.reason); return }
    rt.bind(r.session)
    const outcome = await rt.done
    if (!outcome.ok) { await giveUp(outcome.why, r.session); return }
    const session = recordingSession(r.session, rt)
    const l: Live = { s: session, route: 'structured', createdMs: Date.now(), req, declares: reg.declares(saved.harness), reported: false, off: () => {} }
    live.set(id, l)
    l.off = r.session.onExit(e => { void onExit(id, l)(e) })
    report(id, l)
    provider.onReattach?.(id, { ok: true })
  }

  const backend: StructuredBackend = {
    ...base,
    id: base.id,
    structuredSessions: () => [...live].map(([id, l]) => ({ id, route: l.route, driver: l.s.driver })),
    reattach() {
      if (!durable) return Promise.resolve()
      reattaching ??= (async () => {
        for (const id of durable.dead()) durable.remove(id)
        const ids = durable.alive().filter(id => !live.has(id))
        if (ids.length === 0) return
        const reg = await provider.structured().catch(() => null)
        await Promise.all(ids.map(id => reattachOne(id, reg).catch(() => {})))
      })()
      return reattaching
    },
    async toTerminal(id) {
      const l = live.get(id)
      const durableAlive = !l && !!durable && durable.isAlive(id)
      if (!(l && l.route === 'structured') && !durableAlive) return { ok: false, why: 'not-structured' }
      const saved = l ? null : durable!.saved(id)
      const req: BackendSpawn | null = l ? l.req
        : saved ? { id, cwd: saved.backend.cwd, argv: [], ...(saved.backend.structured ? { structured: saved.backend.structured as BackendSpawn['structured'] } : {}) } : null
      if (!req) return { ok: false, why: 'not-structured' }
      const conv = l?.s.conversationId() ?? (await provider.conversationOf?.(id).catch(() => null)) ?? req.structured?.resumeId ?? null
      if (!conv) return { ok: false, why: 'no-conversation' }
      const resume = provider.resumeSpawn ? await provider.resumeSpawn(req, conv).catch(() => null) : null
      if (!resume) return { ok: false, why: 'no-resume' }
      // End the child FIRST and wait until it is gone: two processes must never write one conversation.
      durable?.markEnding(id, 'terminal')
      if (l) { live.delete(id); l.off(); l.s.dispose() }
      if (durable && !await durable.terminate(id).catch(() => false)) return { ok: false, why: 'still-running' }
      durable?.remove(id)
      const ok = await base.spawn({ ...resume, id }).then(() => true, () => false)
      return ok ? { ok: true } : { ok: false, why: 'spawn-failed' }
    },
    async spawn(req) {
      const harness = req.structured?.harness ?? harnessOfArgv(req.argv)
      const flagOn = provider.flagOn?.() ?? false
      const origin = req.structured?.origin
      // Only ask what this route needs: flag off and not web → never touch `structured()`.
      const wantsStructured = flagOn && origin === 'web' && harness !== null
      const acp = await provider.acp().catch(() => null)
      const reg = wantsStructured
        ? (await provider.structured().catch(() => null)) ?? (acp ? acpAsStructured(acp) : null)
        : null
      const acpDriven = !!(acp && harness && acp.harnesses().includes(harness))
      const route = routeSpawn({
        flagOn, ...(origin ? { origin } : {}), harness,
        driver: reg && harness ? reg.driverFor(harness) : null,
        acpDriven,
        acpOptIn: acpDriven ? await provider.allowed().catch((): readonly string[] => []) : [],
      })
      if (route !== 'tmux' && harness) {
        if (await startVia(req, route, harness, reg ?? acpAsStructured(acp!), acp)) return {}
        // A refused structured start: the same request, the usual way.
      }
      return base.spawn(req)
    },
    async list() {
      if (reattaching) await reattaching
      const rows = await base.list()
      const mine: BackendSession[] = [...live].map(([id, l]) => {
        if (l.route === 'structured') report(id, l)
        return { id, createdMs: l.createdMs, attached: false, alive: l.s.activity() !== 'exited', lastActivityMs: l.s.lastActivityMs() }
      })
      // F2.0b — a structured child this process does not drive (another process owns it, or the
      // re-attach has not run here) is still RUNNING: it must not read as lost.
      const known = new Set([...rows.map(r => r.id), ...mine.map(r => r.id)])
      const elsewhere: BackendSession[] = durable
        ? durable.alive().filter(id => !known.has(id)).map(id => ({ id, createdMs: Date.now(), attached: false, alive: true, lastActivityMs: durable.lastActivityMs(id) }))
        : []
      return [...rows, ...mine, ...elsewhere]
    },
    async capture(id, lines) { const s = of(id); return s ? s.screen(lines) : base.capture(id, lines) },
    async captureTerminal(id, lines): Promise<TerminalCapture | null> {
      const s = of(id)
      if (!s) return base.captureTerminal(id, lines)
      const shown = s.screen(lines)
      return { lines: shown, info: { cols: 120, rows: Math.max(1, shown.length), cursorX: 0, cursorY: Math.max(0, shown.length - 1), alive: s.activity() !== 'exited', historySize: 0 } }
    },
    async sendText(id, text) { const s = of(id); return s ? s.prompt(text) : base.sendText(id, text) },
    async sendTextRaw(id, text) { return of(id) ? false : base.sendTextRaw(id, text) },
    async sendPaste(id, text) { return of(id) ? false : base.sendPaste(id, text) },
    async sendKey(id, key) {
      const s = of(id)
      if (!s) return base.sendKey(id, key)
      if (/^[1-9]$/.test(key)) return s.answer({ choice: Number(key) })
      if (key === 'Escape' || key === 'C-c') { s.cancel(); return true }
      return false
    },
    async kill(id) {
      const l = live.get(id)
      const relayed = !!durable && (l ? l.route === 'structured' : durable.isAlive(id))
      if (!l && !relayed) return base.kill(id)
      if (relayed) durable!.markEnding(id, 'killed')
      if (l) { live.delete(id); l.off(); l.s.dispose() }
      if (!relayed) return true
      const gone = await durable!.terminate(id).catch(() => false)
      if (gone) durable!.remove(id)
      return gone
    },
    attachCommand(id) {
      const l = live.get(id)
      if (!l && durable?.isAlive(id)) return ['sh', '-c', `echo "${STRUCTURED_ATTACH}"`]
      if (!l) return base.attachCommand(id)
      return ['sh', '-c', `echo "${l.route === 'acp-legacy' ? LEGACY_ATTACH : STRUCTURED_ATTACH}"`]
    },
    activityOf(id) { const s = of(id); return s ? toActivity(s.activity()) : base.activityOf?.(id) },
    dialogOf(id) {
      const s = of(id)
      if (!s) return base.dialogOf?.(id)
      return s.attention()?.options.map(o => o.label)
    },
    attentionOf(id) { const l = structuredOnly(id); return l ? l.s.attention() : base.attentionOf?.(id) },
    async answer(id, a: StructuredAnswer) { const l = structuredOnly(id); return l ? l.s.answer(a) : (base.answer?.(id, a) ?? false) },
    chatOf(id) {
      const l = structuredOnly(id)
      if (!l) return base.chatOf?.(id)
      return { chat: sessionChat(l.s, l.declares), conversationId: l.s.conversationId() ?? id }
    },
  }
  // Optional verbs: a structured session answers a free-text option through its driver; the rest it
  // has none of. A tmux session keeps its own.
  if (base.sendChoiceText) {
    backend.sendChoiceText = (id, k, t, opened) => {
      const s = of(id)
      if (!s) return base.sendChoiceText!(id, k, t, opened)
      if (!/^[1-9]$/.test(k)) return Promise.resolve('failed' as const)
      return Promise.resolve(s.answer({ choice: Number(k), text: t }) ? 'sent' as const : 'failed' as const)
    }
  }
  if (base.sendMoveChoice) backend.sendMoveChoice = (id, keys, confirmKey, landed) => (of(id) ? Promise.resolve('failed' as const) : base.sendMoveChoice!(id, keys, confirmKey, landed))
  if (base.rewindTo) backend.rewindTo = (id, text, occurrence) => (of(id) ? Promise.resolve('failed' as const) : base.rewindTo!(id, text, occurrence))
  if (base.sendQueuedNow) backend.sendQueuedNow = id => (of(id) ? Promise.resolve('nothing' as const) : base.sendQueuedNow!(id))
  return backend
}
