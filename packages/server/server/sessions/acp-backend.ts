/**
 * acp-backend.ts — A5.4: a COMPOSITE `SessionBackend`. A spawn whose harness the person opted into
 * (`preferences.acpHarnesses`) and that the engine drives over ACP (`engine.acp`, engine-api 1.7) is
 * started THERE — no terminal, the agent states its own state. Everything else, and every ACP start
 * that fails, goes to the base backend (tmux): tmux is the fallback, always.
 *
 * What each verb means for an ACP session:
 * - `capture` / `captureTerminal` — the driver's rendered view (the person's own conversation, as a
 *   tmux capture shows it today; never journaled);
 * - `sendText` — the next prompt (queued by the driver; one in flight);
 * - `sendKey('<digit>')` — answer the open permission by its number (how the fleet already answers a
 *   numbered dialog); `Escape` / `C-c` — cancel the turn;
 * - `kill` — end the agent; `attachCommand` — there is no terminal to attach to, said;
 * - `activityOf` / `dialogOf` — the state and the options the protocol states.
 */
import type { EngineAcp, EngineAcpSession, HarnessId } from '@agentistics/engine-api'
import { SPAWN_SPECS } from './spawn-spec'
import type { BackendSession, SessionActivity, SessionBackend, TerminalCapture } from './types'

export interface AcpProvider {
  acp(): Promise<EngineAcp | null>
  /** The harnesses the person opted into, read fresh each spawn. */
  allowed(): Promise<readonly string[]>
}

/** Which harness an argv starts — by its binary's base name against the spawn specs. */
export function harnessOfArgv(argv: readonly string[]): HarnessId | null {
  const bin = (argv[0] ?? '').split(/[\\/]/).pop() ?? ''
  for (const [h, spec] of Object.entries(SPAWN_SPECS)) if (spec && spec.bin === bin) return h as HarnessId
  return null
}

const toActivity = (a: ReturnType<EngineAcpSession['activity']>): SessionActivity => (a === 'starting' ? 'working' : a)

export function withAcp(base: SessionBackend, provider: AcpProvider): SessionBackend & { acpSessions(): string[] } {
  const live = new Map<string, { s: EngineAcpSession; createdMs: number }>()
  const of = (id: string) => live.get(id)?.s

  const backend: SessionBackend & { acpSessions(): string[] } = {
    ...base,
    id: base.id,
    acpSessions: () => [...live.keys()],
    async spawn(req) {
      const acp = await provider.acp().catch(() => null)
      const harness = harnessOfArgv(req.argv)
      if (acp && harness && acp.harnesses().includes(harness) && (await provider.allowed().catch((): readonly string[] => [])).includes(harness)) {
        const r = await acp.start({ id: req.id, harness, cwd: req.cwd, ...(req.initialPrompt ? { initialPrompt: req.initialPrompt.text } : {}) }).catch(() => null)
        if (r && r.ok) { live.set(req.id, { s: r.session, createdMs: Date.now() }); return {} }
        // Fallback: the same request, the usual way.
      }
      return base.spawn(req)
    },
    async list() {
      const rows = await base.list()
      const mine: BackendSession[] = [...live].map(([id, { s, createdMs }]) => ({
        id, createdMs, attached: false, alive: s.activity() !== 'exited', lastActivityMs: s.lastActivityMs(),
      }))
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
      if (/^[1-9]$/.test(key)) return s.answer(Number(key))
      if (key === 'Escape' || key === 'C-c') { s.cancel(); return true }
      return false
    },
    async kill(id) {
      const s = of(id)
      if (!s) return base.kill(id)
      s.dispose()
      live.delete(id)
      return true
    },
    attachCommand(id) {
      return of(id) ? ['sh', '-c', 'echo "This session is driven over ACP: there is no terminal to attach to. Use the fleet to prompt it."'] : base.attachCommand(id)
    },
    activityOf(id) { const s = of(id); return s ? toActivity(s.activity()) : base.activityOf?.(id) },
    dialogOf(id) { const s = of(id); return s ? s.dialog()?.options : base.dialogOf?.(id) },
  }
  // Optional verbs: an ACP session has none of them; a tmux one keeps its own.
  if (base.sendChoiceText) backend.sendChoiceText = (id, k, t, opened) => (of(id) ? Promise.resolve('failed' as const) : base.sendChoiceText!(id, k, t, opened))
  if (base.sendMoveChoice) backend.sendMoveChoice = (id, keys, confirmKey, landed) => (of(id) ? Promise.resolve('failed' as const) : base.sendMoveChoice!(id, keys, confirmKey, landed))
  if (base.rewindTo) backend.rewindTo = (id, text, occurrence) => (of(id) ? Promise.resolve('failed' as const) : base.rewindTo!(id, text, occurrence))
  if (base.sendQueuedNow) backend.sendQueuedNow = id => (of(id) ? Promise.resolve('nothing' as const) : base.sendQueuedNow!(id))
  return backend
}
