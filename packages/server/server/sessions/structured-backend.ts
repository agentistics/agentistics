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
    ...(req.env ? { env: req.env } : {}),
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

  const onExit = (id: string, l: Live) => async (e: StructuredExit) => {
    if (live.get(id) !== l || e.kind !== 'failed') return
    live.delete(id)
    l.off()
    const conv = l.s.conversationId() ?? l.req.structured?.resumeId ?? l.req.structured?.conversationId ?? null
    const resume = conv && provider.resumeSpawn ? await provider.resumeSpawn(l.req, conv).catch(() => null) : null
    let resumed = false
    if (resume) resumed = await base.spawn({ ...resume, id }).then(() => true, () => false)
    provider.onFallback?.(id, { reason: e.reason, resumed })
  }

  async function startVia(req: BackendSpawn, route: Exclude<SpawnRoute, 'tmux'>, harness: HarnessId, reg: EngineStructured, acp: EngineAcp | null): Promise<boolean> {
    const r: StructuredStart = route === 'structured'
      ? await reg.start(structuredSpawnOf(req, harness)).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'start failed' }))
      // A5.4, exactly as before: id, harness, cwd and the initial prompt's text.
      : await acp!.start({ id: req.id, harness, cwd: req.cwd, ...(req.initialPrompt ? { initialPrompt: req.initialPrompt.text } : {}) })
        .then(x => (x.ok ? { ok: true as const, session: acpSessionAsStructured(x.session, harness) } : x), () => ({ ok: false as const, reason: 'start failed' }))
    if (!r.ok) return false
    const l: Live = { s: r.session, route, createdMs: Date.now(), req, declares: route === 'structured' ? reg.declares(harness) : null, reported: false, off: () => {} }
    live.set(req.id, l)
    l.off = r.session.onExit(e => { void onExit(req.id, l)(e) })
    if (route === 'structured') { provider.onStarted?.(req.id, r.session.driver); report(req.id, l) }
    return true
  }

  const backend: StructuredBackend = {
    ...base,
    id: base.id,
    structuredSessions: () => [...live].map(([id, l]) => ({ id, route: l.route, driver: l.s.driver })),
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
      const rows = await base.list()
      const mine: BackendSession[] = [...live].map(([id, l]) => {
        if (l.route === 'structured') report(id, l)
        return { id, createdMs: l.createdMs, attached: false, alive: l.s.activity() !== 'exited', lastActivityMs: l.s.lastActivityMs() }
      })
      return [...rows, ...mine]
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
      if (!l) return base.kill(id)
      live.delete(id)
      l.off()
      l.s.dispose()
      return true
    },
    attachCommand(id) {
      const l = live.get(id)
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
